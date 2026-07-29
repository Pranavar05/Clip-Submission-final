# Airtable Database Setup Guide

Follow this guide to configure your Airtable Base (`appUnRcRnUKlgrWQ1`) to work with **both** the existing payout system and the new Clip Submission System v2.

> **⚠️ IMPORTANT**: Your base already contains working `Campaigns`, `Team Members`, and `Submissions` tables used by the payout system. **Do NOT delete or rename existing fields.** This guide only adds new fields and one new table.

---

## Step 1: Create the `Creators` Table (NEW)

This table powers the Creator dropdown on the web upload portal. Each creator can link to a default campaign for automatic rate assignment.

### Columns Configuration:

| Field Name | Type | Options / Config | Description |
|---|---|---|---|
| **Name** | `Single line text` | **Primary Field** | Creator display name (e.g. `StreamerX`). |
| **Platform** | `Single select` | `Twitch`, `YouTube`, `TikTok`, `Kick` | Primary streaming platform. |
| **Status** | `Single select` | `Active`, `Inactive` | Only `Active` creators appear in the upload dropdown. |
| **Default Campaign** | `Link to another record` | Target: **`Campaigns`** table | Auto-assigns this campaign when a clip is uploaded for this creator. |
| **Notes** | `Long text` | Optional | Reference notes. |

### After creating the table:
1. Add your active creators (e.g. `Creator Alpha`, `Creator Beta`).
2. Set their Status to `Active`.
3. Link each creator to their default campaign in the `Campaigns` table.

---

## Step 2: Extend the `Campaigns` Table (MODIFY)

Add **one new field** to link campaigns back to creators.

| New Field | Type | Options / Config | Description |
|---|---|---|---|
| **Creator** | `Link to another record` | Target: **`Creators`** table | Links campaign to its parent creator. |

> All existing fields (`Campaign Name`, `Rate Per Million ($)`, `Status`, `Notes`) remain **untouched**.

---

## Step 3: Extend the `Submissions` Table (MODIFY)

Add the following new fields to the existing `Submissions` table. **Do NOT modify or remove any existing payout fields** (`Clipper`, `Account Manager`, `Campaign`, `Views`, `Clipper %`, `AM %`, `Owner %`, payout formulas, etc.).

### New Fields to Add:

| Field Name | Type | Options / Config | Written By | Description |
|---|---|---|---|---|
| **Submission ID** | `Single line text` | | API | Unique UUID for idempotency/deduplication. |
| **Discord User ID** | `Single line text` | | API | Discord snowflake ID of the submitter. |
| **Discord Username** | `Single line text` | | API | Discord username of the submitter. |
| **Discord Channel ID** | `Single line text` | | API | Origin channel/thread ID. |
| **Creator** | `Link to another record` | Target: **`Creators`** | API | Links to the creator target (separate from Campaign link). |
| **R2 File URL** | `URL` | | API | Public URL of the video on Cloudflare R2. |
| **Original Filename** | `Single line text` | | API | Original uploaded filename. |
| **File Size (MB)** | `Number` | Decimal: `2` | API | File size in megabytes. |
| **Queue Status** | `Single select` | `Pending`, `Processing`, `Completed`, `Failed` | Queue Worker | Tracks async processing state. |
| **Request ID** | `Single line text` | | API | Correlation ID for log tracing. |
| **Error Message** | `Long text` | | Queue Worker | Error details on failure. |
| **Created At** | `Date` | Include time | API | Submission timestamp. |
| **Updated At** | `Date` | Include time | Queue Worker | Last update timestamp. |

### Fields to Keep Untouched (Payout System):

These fields are used by the existing payout calculations and **must not be modified**:

- `Submission` (Primary Field)
- `Clipper` (Link to Team Members)
- `Account Manager` (Link to Team Members)
- `Campaign` (Link to Campaigns)
- `Platform`
- `Clip Type`
- `Is AM's Own Clip`
- `Views`
- `Clipper %` / `AM %` / `Owner %`
- `Clipper Payout ($)` / `AM Payout ($)` / `Owner Payout ($)` / `Total Payout ($)`
- `Last Calculated Views`
- `Rate Used ($/mil)`

---

## Step 4: Extend the `Team Members` Table (MODIFY)

Add **one optional field** to map Discord users to team members.

| New Field | Type | Description |
|---|---|---|
| **Discord User ID** | `Single line text` | Discord snowflake ID for bot-to-team mapping. |

---

## Idempotency

The system checks `Submission ID` before writing to Airtable. If a duplicate UUID is detected during a retry, the write is skipped and a success response is returned. This prevents duplicate rows from network retries.

---

## Verification Checklist

After setup, verify:

- [ ] `Creators` table exists with at least one `Active` creator
- [ ] `Campaigns` table has a new `Creator` linked record field
- [ ] `Submissions` table has all 13 new fields added above
- [ ] `Team Members` table has the `Discord User ID` field
- [ ] Existing payout formula fields still calculate correctly
- [ ] No existing field names were changed
