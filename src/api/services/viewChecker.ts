import Airtable from 'airtable';
import axios from 'axios';
import { config } from '../../shared/config.js';
import { query } from '../../shared/db.js';
import { logger } from '../../shared/logger.js';
import { calculatePayouts } from './payoutCalculator.js';

let isRunning = false;

// Initialize Airtable base
function getBase(): Airtable.Base {
  if (!config.airtable.apiKey || !config.airtable.baseId) {
    throw new Error('Airtable configuration missing (apiKey or baseId).');
  }
  return new Airtable({ apiKey: config.airtable.apiKey }).base(config.airtable.baseId);
}

// Extract 11-character YouTube video ID
export function extractYouTubeVideoId(url: string): string | null {
  const match = url.match(/(?:youtu\.be\/|v=)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// Detect platform from URL
export function detectPlatform(url: string): 'YouTube' | 'TikTok' | null {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
    return 'YouTube';
  }
  if (lowerUrl.includes('tiktok.com')) {
    return 'TikTok';
  }
  return null;
}

// Fetch stats from YouTube API
async function fetchYouTubeViews(videoId: string): Promise<number | null> {
  if (!config.youtubeApiKey) {
    logger.warn('YOUTUBE_API_KEY is not configured. Skipping YouTube views fetch.');
    return null;
  }

  try {
    const res = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'statistics',
        id: videoId,
        key: config.youtubeApiKey,
      },
    });

    const stats = res.data.items?.[0]?.statistics;
    if (stats && stats.viewCount) {
      return Number(stats.viewCount);
    }
  } catch (err: any) {
    logger.error(`Failed to fetch YouTube stats for video ${videoId}:`, err.message);
  }
  return null;
}

// Fetch all records from an Airtable table (handles pagination)
async function listAllAirtableRecords(table: string): Promise<any[]> {
  const base = getBase();
  return new Promise((resolve, reject) => {
    const records: any[] = [];
    base(table)
      .select({ pageSize: 100 })
      .eachPage(
        (pageRecords, fetchNextPage) => {
          records.push(...pageRecords);
          fetchNextPage();
        },
        (err) => {
          if (err) reject(err);
          else resolve(records);
        }
      );
  });
}

// Batch update Airtable records (max 10 records per request)
async function updateAirtableRecordsBatched(table: string, updates: { id: string; fields: any }[]): Promise<void> {
  const base = getBase();
  const CHUNK_SIZE = 10;
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE);
    try {
      await new Promise<void>((resolve, reject) => {
        base(table).update(chunk, (err: any) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (err: any) {
      logger.error(`Airtable batch update failed: ${err.message}`);
    }
  }
}

// Main function to check and update views
export async function checkAndUpdateViews(): Promise<void> {
  if (isRunning) {
    logger.info('View checker is already running. Skipping this pass.');
    return;
  }
  isRunning = true;
  logger.info('Starting YouTube/TikTok view checking pass...');

  try {
    const submissions = await listAllAirtableRecords(config.airtable.submissionsTable);
    
    // Get list of local submission IDs to prevent foreign key errors during DB sync
    const localSubmissions = await query<{ id: string }>('SELECT id FROM submissions');
    const localIds = new Set(localSubmissions.map(s => s.id));

    const airtableUpdates: { id: string; fields: any }[] = [];
    const dbUpdates: { id: string; views: number }[] = [];

    for (const record of submissions) {
      const f = record.fields;
      const postedUrl = f['Posted URL'] as string || f['link'] as string; // Check both Posted URL and link fallback
      if (!postedUrl) continue;

      const platform = detectPlatform(postedUrl);
      if (platform === 'YouTube') {
        const videoId = extractYouTubeVideoId(postedUrl);
        if (!videoId) {
          logger.warn(`Could not extract video ID from YouTube link: ${postedUrl}`);
          continue;
        }

        const viewCount = await fetchYouTubeViews(videoId);
        if (viewCount !== null) {
          logger.info(`YouTube Video ${videoId} has ${viewCount} views`);
          
          // Add to Airtable updates list
          airtableUpdates.push({
            id: record.id,
            fields: { 'Views': viewCount }
          });

          // Add to local DB sync list if it exists in local submissions
          const subId = f['Submission ID'] as string;
          if (subId && localIds.has(subId)) {
            dbUpdates.push({ id: subId, views: viewCount });
          }
        }
      } else if (platform === 'TikTok') {
        // TikTok views are manual for now, so we do not overwrite them with API calls
        // But we still sync whatever Views number exists in Airtable to our local DB view_counts
        const subId = f['Submission ID'] as string;
        const currentViews = f['Views'] as number;
        if (subId && typeof currentViews === 'number' && localIds.has(subId)) {
          dbUpdates.push({ id: subId, views: currentViews });
        }
      }
    }

    // 1. Write view updates back to Airtable
    if (airtableUpdates.length > 0) {
      logger.info(`Updating ${airtableUpdates.length} view counts in Airtable...`);
      await updateAirtableRecordsBatched(config.airtable.submissionsTable, airtableUpdates);
    }

    // 2. Sync view updates to local database view_counts
    if (dbUpdates.length > 0) {
      logger.info(`Syncing ${dbUpdates.length} view counts to local database...`);
      for (const update of dbUpdates) {
        await query(
          `INSERT INTO view_counts (submission_id, count, last_viewed_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)
           ON CONFLICT(submission_id) DO UPDATE SET count = EXCLUDED.count, last_viewed_at = CURRENT_TIMESTAMP`,
          [update.id, update.views]
        );
      }
    }

    logger.info('View checking pass completed. Triggering payout calculations...');

    // 3. Trigger payout calculation
    await calculatePayouts();

  } catch (err: any) {
    logger.error('Error during view checking pass:', err.message);
  } finally {
    isRunning = false;
  }
}

// Background scheduler
export function startViewCheckerInterval(): void {
  const intervalMs = config.viewCheckIntervalMs;
  logger.info(`Initializing background view checker loop (polling every ${intervalMs / 1000}s)...`);
  
  // Run once immediately on startup
  checkAndUpdateViews().catch(err => {
    logger.error('Failed to run initial view check:', err.message);
  });

  setInterval(() => {
    checkAndUpdateViews().catch(err => {
      logger.error('Failed to run periodic view check:', err.message);
    });
  }, intervalMs);
}
