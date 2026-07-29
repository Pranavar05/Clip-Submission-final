# Master Build Prompt — Clip Submission System v2

**Paste everything below into your coding AI (Claude Code or similar), pointed at the existing repo.** It assumes the AI can read the current source (`src/shared/`, `src/api/`, `src/bot/`) before making changes.

---

## 0. Context (give the AI this framing first)

This is a Discord bot + Express API + vanilla HTML/JS web portal that lets clippers submit video files too large for Discord (10–25MB) through a temporary, encrypted, single-use 15-minute link. The bot and API run in **one Node.js process**, sharing modules under `src/shared/`. Current state:

- Token system (AES-256-CBC, key derived from `SHA-256(API_AUTH_TOKEN)`) is solid — **do not touch it.**
- `AirtableService` in `src/api/services/` is currently a **stub**: it logs field names, waits 500ms, and returns a fake record ID. Nothing is persisted anywhere.
- Uploaded files arrive as an in-memory `Buffer` via `multer.memoryStorage()` and are discarded after the response — no file storage exists yet.
- The web portal (`public/` or equivalent) is plain HTML/CSS/JS with four states: loading, error, form, success. It uses XHR (not `fetch`) specifically to get upload-progress events for the progress ring — **keep that.**
- `messageCreate.ts` and `apiClient.ts` exist but are dead code, disconnected from the live flow.
- `CLIPPER_ROLE_ID` currently **silently disables role-checking** if the env var is empty — anyone can submit if this is misconfigured.
- CORS is currently wide open; there's no CSRF protection; no file-content validation beyond extension.
- The Discord notification is sent, and *awaited*, **before** the HTTP response goes back to the browser — the user's browser is blocked on Discord's round-trip, not just on the (future) database write.

You are turning this from a working prototype into a real, production-safe system. Work module-by-module, preserving the existing Controller → Service → External layering. Do not introduce React or a build step for the portal — vanilla JS is correct for this scope and should stay.

---

## 1. Objectives, in priority order

1. Replace the fake `AirtableService` with a real Airtable integration that **cannot fail silently.**
2. Add real file storage (Cloudflare R2), since Airtable is a metadata store, not a file host — landing Airtable without storage just produces spreadsheet rows pointing at nothing.
3. Add a **Creator** selector to the submission form so clippers pick which creator the clip belongs to, with that value validated and persisted.
4. Redesign the portal UI to look like a professional, branded product rather than a bare form.
5. Close the known security gaps (`CLIPPER_ROLE_ID` bypass, open CORS, no file validation, etc.) as a first-class part of this work, not an afterthought.
6. Make sure a burst of concurrent submissions degrades gracefully instead of crashing the process or silently losing data.

---

## 2. Preserve / do not break

- The AES-256-CBC token scheme in `token.ts` — no changes to the crypto.
- The double-check pattern (token validated on page load *and* again on submit).
- The single-process bot+API architecture — do not split this into two services as part of this task; that's a larger, separate migration.
- The vanilla HTML/CSS/JS portal and its XHR-based upload with progress ring.
- TypeScript strict mode throughout.

---

## 3. Part A — Real Airtable Integration

**Package:** use the official `airtable` npm SDK (or Airtable's REST API directly via `fetch` if you prefer no extra dependency — either is fine, but be consistent with how the rest of the codebase handles HTTP).

**New/changed env vars** (add to `.env.example` and document in the README):
```
AIRTABLE_API_KEY=            # Personal Access Token, server-side only, never sent to the client
AIRTABLE_BASE_ID=
AIRTABLE_SUBMISSIONS_TABLE=  # e.g. "Submissions"
AIRTABLE_CREATORS_TABLE=     # e.g. "Creators"
```

**Suggested Airtable schema:**

`Submissions` table:
| Field | Type | Notes |
|---|---|---|
| Submission ID | Single line text | UUID generated server-side *before* the Airtable call — this is your idempotency key |
| Discord User ID | Single line text | |
| Display Name | Single line text | |
| Creator | Link to `Creators` table | See Part B |
| Clip Type | Single select | |
| Note | Long text | Sanitized before write (see Part D) |
| File URL | URL | Points to the R2 object, not an Airtable attachment |
| File Size (MB) | Number | |
| Original Filename | Single line text | |
| Channel ID | Single line text | |
| Submitted At | Date/time | |
| Status | Single select | `Received`, `Stored`, `Failed` |

`Creators` table:
| Field | Type | Notes |
|---|---|---|
| Name | Single line text | Shown in the dropdown |
| Active | Checkbox | Only active creators appear in the dropdown |
| Discord Handle | Single line text | Optional, for cross-reference |

Using a linked-record `Creators` table (rather than a hardcoded list in code) means whoever runs this can add or retire creators from the Airtable UI directly, with no redeploy.

**Rate limiting:** Airtable enforces 5 requests/second per base. Put a queue in front of every Airtable call — `p-queue` configured for a strict `intervalCap: 4, interval: 1000` (leave headroom under the real ceiling) or `bottleneck` with an equivalent config. Every Airtable read or write in the codebase (submissions, creator list, anything future) goes through this one queue instance so the whole app respects a single shared budget.

**Retries:** wrap Airtable calls with exponential-backoff retry (e.g. `p-retry`, 3 attempts, backoff starting at ~500ms) for `429` and `5xx` responses only — don't retry on `4xx` validation errors, since retrying a malformed request just wastes the retry budget.

**Idempotency:** generate the `Submission ID` (UUID) *before* calling Airtable. If a retry occurs after a request that actually succeeded server-side but the response was lost, a second attempt with the same ID should be checked-for (a quick `filterByFormula` lookup) rather than blindly re-inserted, to avoid duplicate rows.

**Failure handling — this is the important behavioral change:** unlike the Discord notification (which the existing docs correctly treat as best-effort, log-and-continue), the Airtable write is the *system of record*. If it fails after retries are exhausted:
- The clipper must **not** see "submitted successfully."
- Return a clear error state to the portal with a **Retry** action that resubmits (re-using the same generated Submission ID, so a retry can't create a duplicate).
- Log the failure at high severity with the Submission ID, so it's traceable even though nothing was persisted.

**Response ordering:** Confirm the Airtable write (and the R2 upload — see below) **before** responding to the browser with success. Move the Discord channel notification to *after* the response is sent (fire-and-forget with one internal retry), so the clipper isn't waiting on Discord's round-trip on top of Airtable's. This also means a Discord outage can no longer block or fail a submission that otherwise succeeded.

---

## 4. Part B — File Storage (Cloudflare R2)

Airtable cannot hold your video files at any real scale — it's a database, not a CDN. Wire in Cloudflare R2 (S3-compatible):

- Use `@aws-sdk/client-s3` against R2's S3-compatible endpoint.
- **Stream the upload instead of buffering it in RAM.** Replace `multer.memoryStorage()` with a streaming approach (`busboy`, or multer configured to pipe rather than buffer) so bytes flow from the incoming request directly to the R2 upload, rather than sitting fully in memory first. This is the single highest-impact change in this whole prompt for stability under concurrent load — without it, 30 simultaneous large uploads can OOM-crash the process (which takes the Discord bot down with it, since they share a process).
- Enforce the 200MB cap at the stream level (abort early) rather than after the whole file has already been received.
- On successful upload, store the resulting object URL (or a signed URL, if the bucket isn't public) in the `File URL` field on the Airtable record.
- If the R2 upload fails, treat it the same as an Airtable failure: no false success message, clear retry path, high-severity log.

---

## 5. Part C — Creator Selection Dropdown

- **Backend:** add `GET /api/creators`, returning the `Active` rows from the `Creators` Airtable table. Cache this in memory with a short TTL (~5 minutes) so the dropdown doesn't hit Airtable's rate limit on every page load, and so the endpoint keeps serving the *last known list* (stale-but-available) if Airtable is briefly unreachable, rather than breaking the form.
- **Frontend:** add a required `<select>` (or a lightweight searchable dropdown if the creator list is expected to grow past ~15–20 entries) to the submission form, populated from `/api/creators` on load. Style it to match the rest of Part D's design system.
- **Validation:** on submit, the server must re-validate the submitted creator value against the current known list — never trust a client-supplied value verbatim. Reject the submission with a clear error if it doesn't match an active creator (this also prevents junk or malicious strings from ending up in the Airtable field).
- Include Creator in both the Airtable record and the Discord notification embed, so the channel post reads naturally (e.g. "New clip submitted for **{Creator}** by {Display Name}").

---

## 6. Part D — Professional UI Redesign

Keep the existing vanilla HTML/CSS/JS approach and the four-state model (loading, error, form, success) — that decision was correct. What needs to change is the visual execution:

- Build an actual small design system in CSS custom properties: a real color palette (not default blues), consistent spacing scale, radius, shadow, and a deliberate typography pairing — avoid the generic "AI-generated SaaS gradient" look.
- Dark-leaning theme fits the Discord context well, with a clear accent color for interactive elements.
- Polish each state:
  - **Form:** clear labels, the new Creator dropdown, inline validation (e.g. reject non-video file types before upload starts, not after), a drag-and-drop zone with a visible hover/active state, disabled + spinner state on the submit button while uploading.
  - **Loading/progress:** keep the circular progress ring (XHR-driven), but make it visually part of the same system rather than a bolted-on widget.
  - **Error:** distinguish between "your link expired" (dead end, tell them to re-request) and "the upload failed, here's a retry button" (recoverable) — these are different failure classes and should look and read differently.
  - **Success:** a real confirmation card — filename, creator, clip type, and a note that the team's been notified — not just a bare "success" message.
- Fully responsive (clippers will open this from their phones as often as from a desktop).
- Accessible: proper `<label>` associations, sufficient contrast, keyboard-navigable dropdown and drag zone, visible focus states.
- Add a small brand mark / favicon so the page doesn't feel like a bare dev tool.

---

## 7. Part E — Security Hardening

Treat every item below as required, not optional, before this goes anywhere near a real deployment:

1. **`CLIPPER_ROLE_ID`:** fail startup loudly (throw and exit the process) if this env var is unset or empty. Never allow the role check to silently disable itself — a missing config value should be a hard stop, not an open door.
2. **CORS:** lock to an explicit allow-list of origins from an env var (e.g. `ALLOWED_ORIGIN`), not `*`.
3. **Security headers:** add `helmet` (or equivalent) to the Express app.
4. **CSRF:** since auth is via `Authorization: Bearer` (not cookies), classic CSRF risk is inherently lower — but confirm no session cookie is in play anywhere, and add origin/referer checks on state-changing routes as defense in depth.
5. **File validation:** don't trust the file extension. Sniff actual file content (magic bytes — e.g. the `file-type` package) and reject mismatches (a `.mp4` that isn't actually a video container should be rejected, not stored).
6. **Rate limit `GET /api/portal-session`** — it currently has no rate limit at all; token expiry alone isn't a substitute.
7. **Sanitize all user-supplied text** (note, clip type, creator) before it goes into a Discord embed (prevent embed/markdown injection) and before it's written to Airtable (prevent formula-injection style issues if any Airtable formulas reference these fields).
8. **Logging discipline:** never log the raw token, the decrypted payload, `AIRTABLE_API_KEY`, or full file contents. Redact in all log output.
9. **Secrets:** everything sensitive stays in environment variables, never committed. Update `.env.example` with every new variable this work introduces, with a one-line comment on what each does.
10. **Dead code:** remove `messageCreate.ts` and `apiClient.ts` (or, if there's a real plan to use them, properly re-wire and test them — don't leave a file that imports a service that no longer exists sitting in the tree as a landmine).
11. **Error responses:** never leak stack traces, internal file paths, or raw exception messages to the client. Map internal errors to a small set of safe, user-facing messages.
12. *Optional, worth flagging even if deferred:* a malware/virus scan hook (ClamAV or a cloud scanning API) on uploaded files before marking a submission `Stored` — not required for v1, but worth a `TODO` with a clear note if skipped.

---

## 8. Part F — Reliability

- `GET /api/health` should also do a lightweight Airtable connectivity check (not a full write — a cheap read is enough) so uptime monitoring reflects real degradation, not just "the process is alive."
- Add structured logging (`pino` or `winston`) with a request ID attached to every log line touching a given submission, so a failed Airtable write and its retry can be traced end-to-end.
- Confirm the rate-limiter's "check" and "record" steps for a given user happen with no `await` between them (protecting against a double-click race) — if there is an `await` in between, close that gap.
- Production should run the compiled `dist/` build via `npm run build && npm start`, not `tsx`.

---

## 9. Acceptance criteria — verify before calling this done

- [ ] A normal submission produces a real row in the `Submissions` Airtable table **and** a real object in R2, with the Airtable row's `File URL` pointing at it.
- [ ] Killing Airtable connectivity mid-test (bad API key, or a firewall block) produces a clear failure state in the browser — **not** a false "success" — with a working retry.
- [ ] Simulating ~30 concurrent large-file submissions does not OOM-crash the process; memory stays bounded because uploads stream rather than buffer.
- [ ] Starting the server with `CLIPPER_ROLE_ID` unset causes the process to refuse to start, with a clear error message.
- [ ] The Creator dropdown populates from Airtable, and submitting with a tampered/invalid creator value (e.g. via direct API call, bypassing the dropdown) is rejected server-side.
- [ ] A request from a disallowed origin is blocked by CORS.
- [ ] A file with a `.mp4` extension but non-video content is rejected.
- [ ] A submission still succeeds and returns to the browser even if the Discord notification fails outright (simulate by revoking the bot's channel permission mid-test).
- [ ] Removing `messageCreate.ts` / `apiClient.ts` doesn't break the build.

## 10. Deliverables expected

- Updated source with the above changes, following existing file/folder conventions (`src/api/services/airtable.ts`, a new `src/api/services/storage.ts` for R2, updates to `controllers.ts`, `routes.ts`, shared types in `src/shared/`).
- An updated `.env.example`.
- A short `AIRTABLE_SETUP.md` or README section describing the base/table schema above, so it can be recreated from scratch.
- A brief summary of what changed and any decisions made where this prompt left room for judgment (e.g. exact retry counts, exact cache TTL).

Work incrementally — Part A/B (Airtable + storage) first since everything else depends on real persisted data, then Part C (creator dropdown, which needs the Creators table to exist), then Part D (UI) and Part E (security) can proceed in parallel, with Part F last as a final pass.
