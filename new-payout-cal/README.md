# New Tec — Payout Calculator

Pure payout logic as a single drop-in file. **No dependencies, no network,
no Airtable, no environment variables.** Works in Node, bundlers and the
browser.

```
payout_calculator.js         the module — this is the deliverable
test_payout_calculator.js    57 assertions, run before you ship
```

---

## The model

```
total       = (views / 1,000,000) × ratePerMillion
role payout = total × that role's percentage
```

The **campaign** supplies the rate. The **clip scenario** supplies the
percentages. Nothing else affects the number.

Four roles: **clipper** (sourcer/finder), **editor**, **accountManager**
(posting + caption + page), **agency** (house share). The principle is that
whoever does a piece of work gets that piece — when one person does several
jobs, they get the combined share.

---

## Usage

```js
const calc = require("./payout_calculator");

// Do this once at startup. If it returns anything, refuse to run —
// a table that doesn't total 100% means every clip pays out wrong.
const problems = calc.validateSplits();
if (problems.length) throw new Error(problems.join("\n"));

const result = calc.calculatePayout({
  views: 250000,
  ratePerMillion: 300,
  clipType: "Original-Edited",
  platform: "TikTok",
  isAMOwnClip: false,   // optional
  hasEditor: true,      // optional — enables warnings
  hasClipper: true,     // optional — enables warnings
});
```

Returns:

```js
{
  total: 75,
  rateUsed: 300,
  payouts:     { clipper: 41.25, editor: 0, accountManager: 18.75, agency: 15 },
  percentages: { clipper: 55,    editor: 0, accountManager: 25,    agency: 20 },
  warnings: []
}
```

`calculatePayout` **throws** on invalid combinations. Catch it and record the
message against the clip — the messages are written to be readable by a
non-technical manager, so they can be surfaced directly in a status field.

### Batches

```js
const results = calc.calculateBatch(clips);
```

Never throws. A failed clip comes back as `{ error, input, payouts: null }`
so one bad record can't abort a whole run.

---

## API

| Function | Purpose |
| --- | --- |
| `validateSplits()` | Returns problems array. Empty = valid. Call at startup. |
| `calculatePayout(input)` | Calculate one clip. Throws on invalid input. |
| `calculateBatch(clips)` | Calculate many. Isolates failures. |
| `getSplit(type, platform, isOwn)` | Raw percentages if you need them directly. |
| `listScenarios()` | All valid scenario names. |
| `scenariosForPlatform(p)` | Scenarios valid on a given platform. |
| `describeScenario(name)` | Full definition — flags, platforms, percentages. |
| `listRetiredScenarios()` | Retired names, for migration checks. |

---

## ⚠ Read this before you structure anything

**There are three scenarios today. That is deliberately minimal, not
finished.** More are coming and existing percentages will change.

**Do not hardcode scenario names anywhere** — not in validation, not in
reporting queries, not in dashboard filters, not in conditional logic. Read
the list at runtime:

```js
calc.listScenarios();                 // populate a dropdown
calc.scenariosForPlatform("TikTok");  // only what's valid there
calc.describeScenario(name);          // flags + percentages for display
```

Adding a scenario should mean **one entry in `SPLITS`** (plus `OWN_SPLITS`
if it can be an AM's own clip) and nothing else. If adding one requires
touching your integration code, the integration is too tightly coupled.

The agency's owner console already lets them invent and configure new
scenarios on the fly, so expect these requests.

---

## Current scenarios

| Scenario | Platforms | Clipper | Editor | Manager | Agency |
| --- | --- | --- | --- | --- | --- |
| Original-Edited | TikTok / X / IG | 55% | — | 25% | 20% |
| Original-Edited | YouTube | 60% | — | 20% | 20% |
| Raw + Edited | TikTok / X / IG | 20% | 35% | 25% | 20% |
| Raw + Edited | YouTube | 20% | 40% | 20% | 20% |
| Ripped + Edited | **YouTube only** | 0% | 0% | **70%** | **30%** |

When `isAMOwnClip` is true (the manager did every job):

| Scenario | Clipper | Editor | Manager | Agency |
| --- | --- | --- | --- | --- |
| Original-Edited | 0% | 0% | 80% | 20% |
| Ripped + Edited | 0% | 0% | 70% | 30% |

### Rules enforced by the module

- **Every clip must be edited.** `Ripped` and `Raw` (unedited) are retired
  and rejected with reclassification instructions.
- **Ripping is account-manager-only and YouTube-only.** Rejected on any
  other platform. Never pays a clipper or editor share.
- **`Raw + Edited` can't be an AM's own clip** — that scenario means the
  work was split between two people.
- **YouTube is the only platform weighted differently.** TikTok, X and
  Instagram share one band.

---

## Warnings vs errors

**Errors** (thrown) mean the clip can't be priced: unknown or retired
scenario, wrong platform, invalid AM's-own combination, bad numbers.

**Warnings** (returned in `result.warnings`) mean it was priced but
something needs attention:

- An editor share is owed but no editor is assigned — that money is
  unallocated.
- Someone is tagged on an AM-only clip and will receive $0.

Warnings only fire if you pass `hasEditor` / `hasClipper`. Surface them
somewhere a human will see them.

---

## Testing

```bash
node test_payout_calculator.js
```

Expect `57 passed, 0 failed`. No credentials or network needed.

**Run this after any change to the split table.** A failure here means
someone would be paid the wrong amount. If you change a percentage, update
the expected values in the test file too — don't just delete the assertion.

---

## Notes for integration

- **Store the rate used with each payout.** `result.rateUsed` is returned for
  this. Percentages are returned too. Without them, historical payouts become
  unauditable the moment a rate or percentage changes.
- **Rates belong to campaigns, not creators.** A creator can run on multiple
  campaigns at different rates simultaneously. When a rate changes, a new
  campaign record should be created rather than editing the old one — that's
  what keeps past payouts accurate to the rate that was live at the time.
- **All money is rounded to 2dp** on output. The four payouts are guaranteed
  to sum to `total`.
