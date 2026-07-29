import { Request, Response } from 'express';
import { query } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { AirtableService } from './services/airtable.js';

const viewRateLimit = new Map<string, number>();
const VIEW_COOLDOWN_MS = 60 * 1000; // 1 view per IP per clip per minute

let leaderboardCache: { data: any[]; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60 * 1000;

export async function handleIncrementView(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rateLimitKey = `${ip}:${id}`;
  const now = Date.now();

  const lastViewed = viewRateLimit.get(rateLimitKey);
  if (lastViewed && now - lastViewed < VIEW_COOLDOWN_MS) {
    res.status(429).json({ success: false, message: 'View already counted. Try again later.' });
    return;
  }

  try {
    const submissions = await query('SELECT id FROM submissions WHERE id = $1', [id]);
    if (!submissions.length) {
      res.status(404).json({ success: false, message: `Submission ${id} not found.` });
      return;
    }

    // Upsert in database
    await query(
      `INSERT INTO view_counts (submission_id, count, last_viewed_at) VALUES ($1, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(submission_id) DO UPDATE SET count = view_counts.count + 1, last_viewed_at = CURRENT_TIMESTAMP`,
      [id]
    );

    leaderboardCache = null;
    viewRateLimit.set(rateLimitKey, now);

    const rows = await query('SELECT count FROM view_counts WHERE submission_id = $1', [id]);
    const count = Number(rows[0]?.count ?? 1);

    logger.info(`View incremented for submission ${id} → ${count} total views`);

    // Sync to Airtable in background
    AirtableService.updateSubmissionViews(id, count).catch((err) => {
      logger.error(`Error background syncing views to Airtable for ${id}:`, err);
    });

    res.status(200).json({ success: true, count });
  } catch (err: any) {
    logger.error(`Failed to increment view for submission ${id}:`, err.message);
    res.status(500).json({ success: false, message: 'Failed to increment view count.' });
  }
}

export async function handleGetStats(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  try {
    const rows = await query(
      `SELECT c.id, c.discord_username, c.user_id, c.clip_type, c.description, c.submitted_at, c.status,
              COALESCE(v.count, 0) as view_count, v.last_viewed_at
       FROM submissions c
       LEFT JOIN view_counts v ON c.id = v.submission_id
       WHERE c.id = $1`,
      [id]
    );

    if (!rows.length) {
      res.status(404).json({ success: false, message: `Submission ${id} not found.` });
      return;
    }

    res.status(200).json({ success: true, stats: rows[0] });
  } catch (err: any) {
    logger.error(`Failed to get stats for submission ${id}:`, err.message);
    res.status(500).json({ success: false, message: 'Failed to retrieve stats.' });
  }
}

export async function handleGetLeaderboard(req: Request, res: Response): Promise<void> {
  const limit = Math.min(parseInt((req.query.limit as string) || '10', 10), 25);
  const now = Date.now();

  try {
    if (leaderboardCache && now < leaderboardCache.expiresAt) {
      res.status(200).json({ success: true, leaderboard: leaderboardCache.data.slice(0, limit), cached: true });
      return;
    }

    const rows = await query(
      `SELECT c.id, c.discord_username, c.user_id, c.clip_type, c.description, c.submitted_at,
              COALESCE(v.count, 0) as view_count
       FROM submissions c
       LEFT JOIN view_counts v ON c.id = v.submission_id
       ORDER BY view_count DESC, c.submitted_at ASC
       LIMIT $1`,
      [25]
    );

    leaderboardCache = { data: rows, expiresAt: now + CACHE_TTL_MS };
    res.status(200).json({ success: true, leaderboard: rows.slice(0, limit), cached: false });
  } catch (err: any) {
    logger.error(`Failed to get leaderboard:`, err.message);
    res.status(500).json({ success: false, message: 'Failed to retrieve leaderboard.' });
  }
}
