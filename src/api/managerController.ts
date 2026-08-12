import { Request, Response } from 'express';
import { query } from '../shared/db.js';
import { logger } from '../shared/logger.js';
import { config } from '../shared/config.js';
import { MANAGERS } from '../shared/managers.js';
import { AirtableService } from './services/airtable.js';

export async function handleManagerLogin(req: Request, res: Response): Promise<void> {
  const { id, password } = req.body;

  if (!id || !password) {
    res.status(400).json({ success: false, message: 'Missing manager ID or password.' });
    return;
  }

  const manager = MANAGERS.find(m => m.id === id && m.password === password);
  if (!manager) {
    res.status(401).json({ success: false, message: 'Invalid manager ID or password.' });
    return;
  }

  res.status(200).json({
    success: true,
    manager: {
      id: manager.id,
      name: manager.name
    }
  });
}

export async function handleGetManagerSubmissions(req: Request, res: Response): Promise<void> {
  try {
    const submissions = await query<any>(
      `SELECT s.id, s.clip_type, s.discord_username, s.description, s.object_key, s.status, 
              s.manager_name, s.flagged_by_manager_id, s.rejection_note, c.name as creator_name
       FROM submissions s
       LEFT JOIN creators c ON s.creator_id = c.id
       WHERE s.status IN ('READY_FOR_REVIEW', 'FLAGGED', 'UPLOADED')
       ORDER BY s.submitted_at DESC`
    );

    const mappedSubmissions = submissions.map((sub: any) => {
      const fileUrl = config.mockStorage
        ? `${config.apiBaseUrl}/uploads/${sub.object_key}`
        : `${config.r2.publicUrl}/${sub.object_key}`;

      return {
        id: sub.id,
        clipType: sub.clip_type,
        discordUsername: sub.discord_username,
        creator: sub.creator_name || 'Unknown Creator',
        note: sub.description || '',
        status: sub.status,
        managerName: sub.manager_name || '',
        flaggedByManagerId: sub.flagged_by_manager_id || '',
        rejectionNote: sub.rejection_note || '',
        fileUrl
      };
    });

    res.status(200).json({ success: true, submissions: mappedSubmissions });
  } catch (err: any) {
    logger.error('Failed to fetch manager submissions:', err.message);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  }
}

export async function handleReviewSubmission(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { action, note, managerId, managerName, postedUrl, platform } = req.body;

  if (!action || !managerId || !managerName) {
    res.status(400).json({ success: false, message: 'Missing action, managerId, or managerName.' });
    return;
  }

  try {
    // 1. Get submission to verify flag constraints
    const subs = await query<any>('SELECT * FROM submissions WHERE id = $1', [id]);
    if (subs.length === 0) {
      res.status(404).json({ success: false, message: 'Submission not found.' });
      return;
    }

    const sub = subs[0];
    if (sub.flagged_by_manager_id && sub.flagged_by_manager_id !== managerId) {
      res.status(403).json({ success: false, message: 'This submission has been flagged by another manager and cannot be modified.' });
      return;
    }

    const dbStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const airtableStatus = action === 'approve' ? 'Completed' : 'Rejected';

    if (action === 'reject' && !note) {
      res.status(400).json({ success: false, message: 'A rejection note is required.' });
      return;
    }

    // 2. Update database locally
    await query(
      `UPDATE submissions
       SET status = $1, manager_name = $2, rejection_note = $3, flagged_by_manager_id = NULL, updated_at = $4
       WHERE id = $5`,
      [dbStatus, managerName, note || null, new Date(), id]
    );

    // 3. Update Airtable
    await AirtableService.updateSubmissionReviewStatus(id, airtableStatus, managerName, note, postedUrl, platform);

    res.status(200).json({ success: true, message: `Submission successfully ${dbStatus.toLowerCase()}.` });
  } catch (err: any) {
    logger.error('Failed to review submission:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update review status.' });
  }
}

export async function handleFlagSubmission(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { managerId } = req.body;

  if (!managerId) {
    res.status(400).json({ success: false, message: 'Missing managerId.' });
    return;
  }

  try {
    const subs = await query<any>('SELECT * FROM submissions WHERE id = $1', [id]);
    if (subs.length === 0) {
      res.status(404).json({ success: false, message: 'Submission not found.' });
      return;
    }

    const sub = subs[0];
    if (sub.flagged_by_manager_id && sub.flagged_by_manager_id !== managerId) {
      res.status(403).json({ success: false, message: 'This submission is already flagged by another manager.' });
      return;
    }

    const newFlag = sub.flagged_by_manager_id ? null : managerId;
    const newStatus = newFlag ? 'FLAGGED' : 'READY_FOR_REVIEW';

    await query(
      `UPDATE submissions
       SET flagged_by_manager_id = $1, status = $2, updated_at = $3
       WHERE id = $4`,
      [newFlag, newStatus, new Date(), id]
    );

    res.status(200).json({
      success: true,
      message: newFlag ? 'Submission successfully flagged.' : 'Submission successfully unflagged.',
      flagged: !!newFlag
    });
  } catch (err: any) {
    logger.error('Failed to flag/unflag submission:', err.message);
    res.status(500).json({ success: false, message: 'Failed to update flag state.' });
  }
}
