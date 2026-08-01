/**
 * NEW TEC — YOUTUBE VIEW CHECKER
 * ------------------------------------------------------------------
 * This little program does ONE job: look at every submission that has
 * a "Posted URL" filled in, ask YouTube how many views that video has
 * right now, and write that number into the "Views" field in Airtable.
 *
 * It does NOT calculate payouts itself — payout_service.js already
 * does that automatically whenever "Views" changes. So this script
 * and payout_service.js work as a team:
 *   check_views.js     -> keeps "Views" up to date
 *   payout_service.js  -> notices "Views" changed, recalculates payout
 *
 * ------------------------------------------------------------------
 * SETUP (one time)
 * ------------------------------------------------------------------
 * 1. Put this file in the SAME folder as payout_service.js.
 * 2. Make sure your .env file (same one payout_service.js uses)
 *    also has this line added:
 *      YOUTUBE_API_KEY=your_real_key_here
 * 3. In Airtable's Submissions table, add a field called:
 *      Posted URL   (type: URL)
 *    Paste the real YouTube link into that field once a clip is live.
 *
 * ------------------------------------------------------------------
 * HOW TO RUN IT
 * ------------------------------------------------------------------
 *   node check_views.js
 *
 * That's it. It runs once, checks every submission with a Posted URL,
 * updates Views in Airtable, prints what it did, and exits.
 */

const axios = require("axios");
require("dotenv").config();

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SUBMISSIONS_TABLE = process.env.SUBMISSIONS_TABLE || "Submissions";

// ---- Safety check: make sure all 3 keys exist before doing anything ----
if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error(
    "Missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID in your .env file. Fix that first."
  );
  process.exit(1);
}
if (!YOUTUBE_API_KEY) {
  console.error(
    "Missing YOUTUBE_API_KEY in your .env file. Add it and try again."
  );
  process.exit(1);
}

const airtable = axios.create({
  baseURL: `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`,
  headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
});

// Pulls the 11-character video ID out of a normal YouTube link,
// e.g. "https://youtu.be/dQw4w9WgXcQ" or "https://youtube.com/watch?v=dQw4w9WgXcQ"
function extractVideoId(url) {
  const match = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// Airtable only gives 100 records per page — this walks every page
// so we don't miss any submissions if the table grows past 100 rows.
async function listAllSubmissions() {
  let records = [];
  let offset;
  do {
    const { data } = await airtable.get(
      `/${encodeURIComponent(SUBMISSIONS_TABLE)}`,
      { params: offset ? { offset, pageSize: 100 } : { pageSize: 100 } }
    );
    records = records.concat(data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

async function checkAllViews() {
  console.log("Checking YouTube views...");

  const records = await listAllSubmissions();
  let checked = 0;
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    const postedUrl = record.fields["Posted URL"];
    if (!postedUrl) {
      skipped++;
      continue; // nothing posted yet, nothing to check
    }

    const videoId = extractVideoId(postedUrl);
    if (!videoId) {
      console.log(`  ! Couldn't find a video ID in: ${postedUrl}`);
      failed++;
      continue;
    }

    try {
      const ytResponse = await axios.get(
        "https://www.googleapis.com/youtube/v3/videos",
        {
          params: {
            part: "statistics",
            id: videoId,
            key: YOUTUBE_API_KEY,
          },
        }
      );

      const stats = ytResponse.data.items[0]?.statistics;
      if (!stats) {
        console.log(`  ! No stats found for video ID: ${videoId} (video may be private or deleted)`);
        failed++;
        continue;
      }

      const viewCount = Number(stats.viewCount);
      console.log(`  ✓ ${videoId} -> ${viewCount.toLocaleString()} views`);

      await airtable.patch(`/${encodeURIComponent(SUBMISSIONS_TABLE)}`, {
        records: [
          {
            id: record.id,
            fields: { Views: viewCount },
          },
        ],
        typecast: true,
      });

      checked++;
    } catch (err) {
      console.error(
        `  ✗ Failed on ${postedUrl}: ${err.response?.data?.error?.message || err.message}`
      );
      failed++;
    }
  }

  console.log(
    `\nDone. Checked ${checked}, skipped ${skipped} (no Posted URL yet), failed ${failed}.`
  );
}

checkAllViews().catch((err) => {
  console.error(
    "\n✗ check_views.js failed to complete:",
    err.response?.data?.error?.message || err.message
  );
  console.error(
    "  (This usually means Airtable or YouTube was unreachable, or a key is invalid/expired. Nothing was corrupted — just try running it again.)"
  );
  process.exit(1);
});
