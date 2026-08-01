/**
 * NEW TEC — CONTINUOUS PAYOUT SERVICE
 * ------------------------------------------------------------------
 * This is the "always running" version of payout_calculator.js.
 *
 * The original script only worked INSIDE Airtable's own Automation
 * editor (it used the `base` / `input` globals that only exist there,
 * and it only fired once per triggering record). This version is a
 * standalone Node.js process that talks to Airtable over its normal
 * REST API, so it can run 24/7 on a server, your laptop, or a host
 * like Railway/Render/a VPS — polling for new/changed submissions on
 * its own schedule instead of waiting on Airtable's automation UI.
 *
 * WHAT IT DOES, EVERY POLL CYCLE:
 *   1. Pulls every record from the Submissions table.
 *   2. Skips anything already fully calculated (Views hasn't changed
 *      since the last time we calculated it).
 *   3. Looks up the linked Campaign's Rate Per Million ($) — NOT a fixed
 *      per-streamer rate. This is what lets the same streamer sit on
 *      multiple campaigns (e.g. Adin Ross on a Kick campaign AND a
 *      Kalshi campaign) at different rates at the same time, and lets
 *      you switch a streamer to a new campaign/rate going forward
 *      without touching the rate that applied to past submissions.
 *   4. Runs the split logic (see getSplit below).
 *   5. Writes the percentages + payouts back to Airtable.
 *   6. Sleeps, then repeats forever (or once, if run with --once).
 *
 * ------------------------------------------------------------------
 * SETUP
 * ------------------------------------------------------------------
 * 1. npm install   (installs the one dependency: axios)
 * 2. Copy .env.example to .env and fill in:
 *      AIRTABLE_API_KEY      - a Personal Access Token (data.records:read/write)
 *      AIRTABLE_BASE_ID      - starts with "app..."
 *      SUBMISSIONS_TABLE     - defaults to "Submissions"
 *      CAMPAIGNS_TABLE       - defaults to "Campaigns"
 *      POLL_INTERVAL_SECONDS - defaults to 60
 * 3. node payout_service.js            (runs forever, polling on a loop)
 *    node payout_service.js --once     (single pass, good for cron/testing)
 *
 * ------------------------------------------------------------------
 * REQUIRED AIRTABLE FIELDS
 * ------------------------------------------------------------------
 * Table: "Campaigns"
 *   - Streamer/Creator (text)      e.g. "Adin Ross"
 *   - Campaign Name (text)         e.g. "Adin Ross — Kick Combat Sports"
 *   - Rate Per Million ($)         e.g. 300
 *   - Status (single select: Active / Inactive)
 *   - Notes (optional)
 *   IMPORTANT: when a rate changes, or a streamer moves to a different
 *   campaign (e.g. Kick -> Kalshi), add a NEW row instead of editing the
 *   old one. Submissions link to a specific campaign row, so past
 *   submissions keep whatever rate was active when they were made, and
 *   the current/new campaign is just a different row you switch NEW
 *   submissions to point at.
 *
 * Table: "Submissions"
 *   - Clipper (link)                     - the sourcer; blank if "Is AM's Own Clip"
 *   - Editor (link)                      - the person who edited the footage, ONLY
 *                                           used for "Raw-Split Edit" (a different
 *                                           clipper edited someone else's raw footage).
 *                                           Leave blank for every other clip type.
 *   - Account Manager (link)
 *   - Campaign (link to Campaigns)       - pick the specific streamer+campaign+rate row
 *   - Platform (single select: TikTok / YouTube / X / Instagram)
 *   - Clip Type (single select: Stolen / Raw / Raw-Split Edit / Original-Edited)
 *   - Is AM's Own Clip (checkbox)
 *   - Views (number)
 *   - Clipper % / Editor % / AM % / Owner % (number)     <- written by script
 *   - Clipper Payout ($) / Editor Payout ($) / AM Payout ($) /
 *     Owner Payout ($) / Total Payout ($)                <- written by script
 *   - Last Calculated Views (number)                      <- written by script
 *   - Rate Used ($/mil) (number)                          <- written by script
 *     (records the exact rate that was applied at calc time, so every
 *     payout is auditable in Airtable itself. If this submission's Views
 *     change again later and the linked Campaign's rate has changed
 *     in-place since then — instead of via a new row, as recommended
 *     above — the service logs a loud warning so you can catch it.)
 *
 * ------------------------------------------------------------------
 * SPLIT LOGIC (confirmed from the Payout System Guide / Lead Manager
 * Build Brief / Owner's Operations Manual — this is the source of truth,
 * do not revert to the older 3-way Ripped/Raw/Original-Edited model)
 * ------------------------------------------------------------------
 * Every rate is built from up to four pieces of work: sourcing (20%),
 * editing (35%, 40% on YouTube), posting+caption / AM (25%, 20% on
 * YouTube), and agency/owner (20%, 30% on Stolen clips).
 *
 *   Stolen clip                                  30 / —  / 40 / 30
 *   Raw (AM sources, edits, and posts it)        20 / —  / 60 / 20
 *   Raw-Split Edit — TikTok / X / Instagram      20 / 35 / 25 / 20
 *   Raw-Split Edit — YouTube                     20 / 40 / 20 / 20
 *   Original-Edited — TikTok / X / Instagram     55 / —  / 25 / 20
 *   Original-Edited — YouTube                    60 / —  / 20 / 20
 *   AM's own Stolen clip                          — / —  / 70 / 30
 *   AM's own Original-Edited clip                 — / —  / 80 / 20
 *
 * IMPORTANT: TikTok, X, and Instagram now share the SAME rate for both
 * Original-Edited and Raw-Split Edit. YouTube is the only platform on
 * its own rate. This is the opposite grouping from the old system,
 * where TikTok was the odd one out and YouTube/X/Instagram shared a
 * rate — don't revert to that.
 *
 * ------------------------------------------------------------------
 * RELIABILITY NOTES
 * ------------------------------------------------------------------
 * - Writes are batched (up to 10 records per Airtable API call) instead
 *   of one-at-a-time, so this stays fast and stays under Airtable's rate
 *   limit even with a large Submissions table.
 * - All Airtable calls automatically retry with exponential backoff if
 *   Airtable responds with a rate-limit (429) or a transient server
 *   error (5xx), instead of failing the whole pass.
 */

const axios = require("axios");
require("dotenv").config();

// ---------------- CONFIG ----------------

const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_ID = process.env.AIRTABLE_BASE_ID;
const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE || "Submissions";
const CAMPAIGNS_TABLE = process.env.CAMPAIGNS_TABLE || "Campaigns";
const POLL_INTERVAL_SECONDS = Number(process.env.POLL_INTERVAL_SECONDS || 60);
const RUN_ONCE = process.argv.includes("--once");

if (!API_KEY || !BASE_ID) {
  console.error(
    "Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID. Copy .env.example to .env and fill both in."
  );
  process.exit(1);
}

const airtable = axios.create({
  baseURL: `https://api.airtable.com/v0/${BASE_ID}`,
  headers: { Authorization: `Bearer ${API_KEY}` },
});

// ---------------- SPLIT LOGIC ----------------

// hasEditor = true when a different clipper edited someone else's raw
// footage (Raw-Split Edit only). Every other clip type ignores this.
function getSplit(clipType, platform, isAMOwnClip, hasEditor) {
  if (isAMOwnClip) {
    if (clipType === "Stolen") return { clipper: 0, editor: 0, am: 0.7, owner: 0.3 };
    if (clipType === "Original-Edited") return { clipper: 0, editor: 0, am: 0.8, owner: 0.2 };
    throw new Error(
      `"Is AM's Own Clip" is checked but Clip Type is "${clipType}" — undefined combination. Only Stolen or Original-Edited apply.`
    );
  }

  if (clipType === "Stolen") return { clipper: 0.3, editor: 0, am: 0.4, owner: 0.3 };

  if (clipType === "Raw") return { clipper: 0.2, editor: 0, am: 0.6, owner: 0.2 };

  if (clipType === "Raw-Split Edit") {
    if (!hasEditor) {
      throw new Error(
        `Clip Type is "Raw-Split Edit" but no Editor is linked. An Editor must be linked for this clip type — without it, 35-40% of the payout has nobody attached to it.`
      );
    }
    if (platform === "YouTube") return { clipper: 0.2, editor: 0.4, am: 0.2, owner: 0.2 };
    // TikTok, X, and Instagram all use the same Raw-Split Edit rate
    return { clipper: 0.2, editor: 0.35, am: 0.25, owner: 0.2 };
  }

  if (clipType === "Original-Edited") {
    if (platform === "YouTube") return { clipper: 0.6, editor: 0, am: 0.2, owner: 0.2 };
    // TikTok, X, and Instagram all use the same Original-Edited rate
    return { clipper: 0.55, editor: 0, am: 0.25, owner: 0.2 };
  }

  throw new Error(`Unrecognized Clip Type: "${clipType}"`);
}

// ---------------- AIRTABLE HELPERS ----------------

// Wraps any Airtable API call with automatic retry + exponential backoff
// on rate limits (429) or transient server errors (5xx). Anything else
// (bad field name, invalid record id, etc.) fails immediately since
// retrying won't fix it.
async function withRetry(fn, { retries = 5, baseDelayMs = 1000 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= retries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      console.warn(
        `  ⏳ Airtable request failed (${status || err.message}), retrying in ${delay}ms... (attempt ${
          attempt + 1
        }/${retries})`
      );
      await sleep(delay);
      attempt++;
    }
  }
}

// Airtable paginates 100 records at a time; walk every page.
async function listAllRecords(table) {
  let records = [];
  let offset;
  do {
    const { data } = await withRetry(() =>
      airtable.get(`/${encodeURIComponent(table)}`, {
        params: offset ? { offset, pageSize: 100 } : { pageSize: 100 },
      })
    );
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// Airtable accepts up to 10 records per PATCH call. Batching updates this
// way means a Submissions table with hundreds of rows still only takes a
// handful of API calls per pass, instead of one call per row.
async function updateRecordsBatched(table, updates) {
  const CHUNK_SIZE = 10;
  const results = { succeeded: [], failed: [] };

  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    try {
      await withRetry(() =>
        airtable.patch(`/${encodeURIComponent(table)}`, {
          records: chunk.map((u) => ({ id: u.id, fields: u.fields })),
          typecast: true,
        })
      );
      results.succeeded.push(...chunk.map((u) => u.id));
    } catch (err) {
      console.error(
        `  ✗ Batch write failed for ${chunk.length} record(s): ${
          err.response?.data?.error?.message || err.message
        }`
      );
      results.failed.push(...chunk.map((u) => u.id));
    }
  }

  return results;
}

// ---------------- CORE PASS ----------------

async function runOnePass() {
  const startedAt = new Date().toISOString();
  console.log(`\n[${startedAt}] Polling Airtable...`);

  const [submissions, campaigns] = await Promise.all([
    listAllRecords(SUBMISSIONS_TABLE),
    listAllRecords(CAMPAIGNS_TABLE),
  ]);

  const campaignById = new Map(campaigns.map((c) => [c.id, c.fields]));

  const updates = [];
  let skipped = 0;
  let failed = 0;

  for (const record of submissions) {
    const f = record.fields;
    const views = f["Views"] || 0;
    const lastCalculatedViews = f["Last Calculated Views"];
    const previousRateUsed = f["Rate Used ($/mil)"];

    // Skip records with no views yet, or that haven't changed since
    // the last time we ran the numbers.
    if (!views || views === lastCalculatedViews) {
      skipped++;
      continue;
    }

    try {
      const platform = f["Platform"];
      const clipType = f["Clip Type"];
      const isAMOwnClip = f["Is AM's Own Clip"] === true;

      const campaignLinks = f["Campaign"];
      if (!campaignLinks || campaignLinks.length === 0) {
        console.warn(`  ! Skipping ${record.id}: no Campaign linked.`);
        failed++;
        continue;
      }
      const campaignFields = campaignById.get(campaignLinks[0]);
      if (!campaignFields) {
        console.warn(
          `  ! Skipping ${record.id}: linked Campaign record not found (may have been deleted).`
        );
        failed++;
        continue;
      }
      const ratePerMillion = campaignFields["Rate Per Million ($)"] || 0;
      const campaignName = campaignFields["Campaign Name"] || "Unknown Campaign";
      const campaignStatus = campaignFields["Status"];
      if (campaignStatus === "Inactive") {
        console.warn(
          `  ⚠ ${record.id}: Campaign "${campaignName}" is marked Inactive — calculating anyway, but double-check the rate.`
        );
      }

      // This is the in-place-rate-edit guard: if this submission was
      // calculated before (it has a previous "Rate Used") and the rate
      // on its linked Campaign has since changed, that means someone
      // edited the Campaign's rate directly rather than adding a new
      // Campaign row — which silently changes this submission's payout.
      // We still calculate (so the sheet isn't stuck), but we flag it
      // loudly so you can verify it was intentional.
      if (
        lastCalculatedViews !== undefined &&
        typeof previousRateUsed === "number" &&
        previousRateUsed !== ratePerMillion
      ) {
        console.warn(
          `  🚨 RATE CHANGED IN PLACE: ${record.id} was previously calculated at $${previousRateUsed}/mil ` +
            `on "${campaignName}", but that Campaign's rate is now $${ratePerMillion}/mil. ` +
            `If this streamer/campaign's rate was supposed to change, that's expected — but if this ` +
            `was meant to be a NEW campaign, add a new Campaigns row instead of editing this one.`
        );
      }

      const editorLinks = f["Editor"];
      const hasEditor = !!(editorLinks && editorLinks.length > 0);

      const split = getSplit(clipType, platform, isAMOwnClip, hasEditor);
      const totalPayout = (views / 1_000_000) * ratePerMillion;
      const clipperPayout = totalPayout * split.clipper;
      const editorPayout = totalPayout * split.editor;
      const amPayout = totalPayout * split.am;
      const ownerPayout = totalPayout * split.owner;

      updates.push({
        id: record.id,
        fields: {
          "Clipper %": split.clipper * 100,
          "Editor %": split.editor * 100,
          "AM %": split.am * 100,
          "Owner %": split.owner * 100,
          "Clipper Payout ($)": round2(clipperPayout),
          "Editor Payout ($)": round2(editorPayout),
          "AM Payout ($)": round2(amPayout),
          "Owner Payout ($)": round2(ownerPayout),
          "Total Payout ($)": round2(totalPayout),
          "Last Calculated Views": views,
          "Rate Used ($/mil)": ratePerMillion,
        },
        logLine: `  ✓ ${record.id} [${campaignName}] — Clipper $${clipperPayout.toFixed(
          2
        )} | Editor $${editorPayout.toFixed(2)} | AM $${amPayout.toFixed(2)} | Owner $${ownerPayout.toFixed(
          2
        )} | Total $${totalPayout.toFixed(2)}`,
      });
    } catch (err) {
      console.error(`  ✗ ${record.id} — ${err.message}`);
      failed++;
    }
  }

  let processed = 0;
  if (updates.length > 0) {
    const { succeeded, failed: failedWrites } = await updateRecordsBatched(SUBMISSIONS_TABLE, updates);
    const succeededSet = new Set(succeeded);
    for (const u of updates) {
      if (succeededSet.has(u.id)) {
        console.log(u.logLine);
        processed++;
      }
    }
    failed += failedWrites.length;
  }

  console.log(
    `[${startedAt}] Done. Processed ${processed}, skipped ${skipped} (already up to date), failed ${failed}.`
  );
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------- ENTRYPOINT ----------------

async function main() {
  if (RUN_ONCE) {
    await runOnePass();
    process.exit(0);
  }

  console.log(
    `Starting continuous payout service. Polling every ${POLL_INTERVAL_SECONDS}s. Ctrl+C to stop.`
  );

  let stopping = false;
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    stopping = true;
  });

  while (!stopping) {
    try {
      await runOnePass();
    } catch (err) {
      console.error("Pass failed:", err.response?.data || err.message);
    }
    await sleep(POLL_INTERVAL_SECONDS * 1000);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main();