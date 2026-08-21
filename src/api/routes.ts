import { Router, Request, Response, NextFunction } from 'express';
import { handlePortalSession, handleWebSubmissionInit, handleWebSubmissionUpload, handleCreators, handleTeamMembers } from './controllers.js';
import { handleIncrementView, handleGetStats, handleGetLeaderboard } from './viewController.js';
import { handleManagerLogin, handleGetManagerSubmissions, handleReviewSubmission, handleFlagSubmission } from './managerController.js';
import { config } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { query } from '../shared/db.js';
import { client } from '../bot/client.js';
import { AirtableService } from './services/airtable.js';
import { R2StorageService } from './services/storage.js';
import { queue } from './services/queue.js';
import { TikTokService } from './services/tiktok.js';

const router = Router();

// ─── IP Rate Limiter for Portal Session Validation ────────────────────────
const ipSessionRequests = new Map<string, number[]>();
const IP_RATE_LIMIT_MAX = 20; // 20 requests
const IP_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

const ipRateLimiter = (req: Request, res: Response, next: NextFunction): void => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  
  const timestamps = ipSessionRequests.get(ip) || [];
  const activeTimestamps = timestamps.filter(ts => now - ts < IP_RATE_LIMIT_WINDOW_MS);
  
  ipSessionRequests.set(ip, activeTimestamps);

  if (activeTimestamps.length >= IP_RATE_LIMIT_MAX) {
    logger.warn(`Rate limit exceeded for IP: ${ip} on portal session verification`);
    res.status(429).json({
      success: false,
      message: 'Too many requests. Please wait a minute and try again.'
    });
    return;
  }

  activeTimestamps.push(now);
  next();
};

// ─── Routes ──────────────────────────────────────────────────────────────

// Validate a web portal session token (with IP rate limiting)
router.get('/portal-session', ipRateLimiter, handlePortalSession);

// Fetch active creators list
router.get('/creators', handleCreators);

// Fetch team members list for collaborator dropdown
router.get('/team-members', handleTeamMembers);

// Web Portal submission (uses custom Busboy parser instead of Multer memory storage)
// Web Portal submission initiation
router.post('/web-submissions/init', handleWebSubmissionInit);

// Web Portal submission file upload (Streaming)
router.post('/web-submissions/upload/:submissionId', handleWebSubmissionUpload);

// Web Portal submission direct R2 upload (Presigned URLs)
import { handlePresignedUrl, handleDirectUploadComplete, handleMockUploadDirect } from './controllers.js';
router.post('/web-submissions/presign/:submissionId', handlePresignedUrl);
router.post('/web-submissions/complete/:submissionId', handleDirectUploadComplete);
router.put('/web-submissions/mock-upload', handleMockUploadDirect);

// View Tracking & Leaderboard
router.post('/view/:id', handleIncrementView);
router.get('/stats/:id', handleGetStats);
router.get('/leaderboard', handleGetLeaderboard);



router.get('/tiktok/callback', async (req: Request, res: Response) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    res.status(400).send(`TikTok authorization failed: ${error_description || error}`);
    return;
  }
  if (!code || !state) {
    res.status(400).send('Missing code or state in callback.');
    return;
  }

  try {
    await TikTokService.exchangeCodeForToken(code as string, state as string);
    res.send(
      '<h2>TikTok connected ✅</h2><p>You can close this tab and go back to Discord.</p>'
    );
  } catch (err: any) {
    logger.error('OAuth callback error:', err.message);
    res.status(500).send('Something went wrong linking your TikTok account. Please try /tiktok-connect again.');
  }
});

// Manager Review Routes
router.post('/manager/login', handleManagerLogin);
router.get('/manager/submissions', handleGetManagerSubmissions);
router.post('/manager/submissions/:id/review', handleReviewSubmission);
router.post('/manager/submissions/:id/flag', handleFlagSubmission);

export default router;

