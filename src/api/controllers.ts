import { Request, Response, NextFunction } from 'express';
import Busboy from 'busboy';
import { Transform, TransformCallback } from 'stream';
import { logger, getLoggerContext } from '../shared/logger.js';
import { AirtableService } from './services/airtable.js';
import { R2StorageService } from './services/storage.js';
import { queue, NonRetryableError } from './services/queue.js';
import { decryptToken, consumeToken } from '../shared/token.js';
import { client } from '../bot/client.js';
import { config, MAX_UPLOAD_SIZE } from '../shared/config.js';
import { ClipType, SubmissionPayload } from '../shared/types.js';
import { sanitizeTextField, sanitizeFilename } from '../shared/sanitizer.js';
import { query, generateSubmissionId, runTransaction } from '../shared/db.js';
import { rateLimiter } from '../shared/rateLimiter.js';
import { uploadCounter, uploadSizeHistogram } from './monitoring.js';

// ─── Magic Byte validator Transform Stream ───────────────────────────────
class MagicByteValidator extends Transform {
  private buffer: Buffer = Buffer.alloc(0);
  private checked = false;
  private maxBytesToCheck = 12; // Standard signatures are within first 12 bytes
  private isValid = true;
  private validationError: Error | null = null;

  _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void {
    if (!this.checked) {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      if (this.buffer.length >= this.maxBytesToCheck) {
        this.checkSignature();
      }
    }
    
    if (this.isValid) {
      this.push(chunk);
      callback();
    } else {
      callback(this.validationError || new Error('Invalid file type'));
    }
  }

  _flush(callback: TransformCallback): void {
    if (!this.checked) {
      this.checkSignature();
    }
    callback(this.validationError || undefined);
  }

  private checkSignature() {
    this.checked = true;
    const header = this.buffer;
    
    // Whitelist check signatures:
    // 1. WebM / MKV: EBML header starting with 1A 45 DF A3
    const isWebmOrMkv = header.length >= 4 && header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3;
    
    // 2. MP4/MOV: ftyp box at index 4 (signature 'ftyp')
    let isMp4OrMov = false;
    if (header.length >= 8) {
      const ftypSig = header.toString('ascii', 4, 8);
      isMp4OrMov = ftypSig === 'ftyp' || ftypSig === 'moov' || ftypSig === 'mdat' || ftypSig === 'free' || ftypSig === 'wide';
    }

    // 3. AVI: Starts with 'RIFF' and has 'AVI ' at index 8
    let isAvi = false;
    if (header.length >= 12) {
      const riff = header.toString('ascii', 0, 4);
      const avi = header.toString('ascii', 8, 12);
      isAvi = riff === 'RIFF' && avi === 'AVI ';
    }

    if (isWebmOrMkv || isMp4OrMov || isAvi) {
      this.isValid = true;
    } else {
      this.isValid = false;
      this.validationError = new Error('File signature verification failed. The uploaded file is not a valid video container.');
    }
  }
}

// ─── Fetch Dynamic Creators List ──────────────────────────────────────────
export async function handleCreators(req: Request, res: Response, next: NextFunction): Promise<void> {
  const requestId = (req as any).requestId || 'unknown';
  try {
    const creators = await AirtableService.getActiveCreators();
    res.status(200).json({ success: true, creators });
  } catch (err: any) {
    logger.error('Failed to get creators list in controller:', { error: err.message, requestId });
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve creators. Please try again later.',
      requestId
    });
  }
}

export async function handleTeamMembers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const requestId = (req as any).requestId || 'unknown';
  try {
    const teamMembers = await AirtableService.getTeamMembersList();
    res.status(200).json({ success: true, teamMembers });
  } catch (err: any) {
    logger.error('Failed to get team members list in controller:', { error: err.message, requestId });
    res.status(500).json({ success: false, message: 'Failed to retrieve team members.', requestId });
  }
}

// ─── Portal Session Validation ────────────────────────────────────────────
export async function handlePortalSession(req: Request, res: Response): Promise<void> {
  const token = req.query.token as string;
  const requestId = (req as any).requestId || 'unknown';

  if (!token) {
    res.status(400).json({ success: false, message: 'Missing session token.', requestId });
    return;
  }

  const payload = await decryptToken(token);
  if (!payload) {
    logger.warn(`Invalid or expired portal session token attempted.`, { requestId });
    res.status(401).json({ success: false, message: 'This session link has expired or is invalid. Please return to Discord and request a new one.', requestId });
    return;
  }

  logger.info(`Verified portal session for user: ${payload.discordUser} (${payload.userId})`, { requestId });
  
  const redirectUrl = payload.serverId 
    ? `https://discord.com/channels/${payload.serverId}/${payload.channelId}`
    : 'https://discord.com/channels/@me';

  res.status(200).json({
    success: true,
    displayName: payload.displayName,
    discordUser: payload.discordUser,
    expiresAt: payload.expiresAt,
    redirectUrl
  });
}

// ─── Web Submission Initiation ─────────────────────────────────────────────
export async function handleWebSubmissionInit(req: Request, res: Response): Promise<void> {
  const requestId = (req as any).requestId || 'unknown';
  const logCtx = getLoggerContext(requestId).child({ module: 'handleWebSubmissionInit' });

  try {
    logCtx.info('Received web submission initiation request');

    // 1. Authenticate & validate session token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Missing authorization token.', requestId });
      return;
    }
    
    const token = authHeader.split(' ')[1];

    // Enforce request validation ahead of processing
    const { creatorId, clipType, editorId, collaboratorRole, description } = req.body;
    const allowedTypes = ['Original-Edited', 'Raw + Edited', 'Ripped + Edited', 'Raw', 'Edited', 'Stolen'];
    if (!clipType || !allowedTypes.includes(clipType)) {
      res.status(400).json({ success: false, message: 'Please select a valid clip type.', requestId });
      return;
    }

    if (!creatorId) {
      res.status(400).json({ success: false, message: 'Please select a valid creator.', requestId });
      return;
    }

    // Validate creator ID against active registry
    const activeCreators = await AirtableService.getActiveCreators();
    const isValidCreator = activeCreators.some(c => c.id === creatorId);
    if (!isValidCreator) {
      logCtx.warn(`Rejected invalid creator submission attempt. Provided ID: ${creatorId}`);
      res.status(400).json({ success: false, message: 'The selected creator is inactive or invalid.', requestId });
      return;
    }

    const submissionId = await generateSubmissionId();
    const sanitizedDescription = sanitizeTextField(description || '');

    // Execute atomic validation and ingestion inside database transaction
    const result = await runTransaction(async (clientQuery) => {
      // 1. Atomically consume token immediately
      const tokenPayload = await consumeToken(token, clientQuery);
      if (!tokenPayload) {
        return { error: 'Your link has expired or has already been used. Return to Discord and click Submit Clip again.' };
      }

      // 2. Cooldown check
      const { limited, timeLeftSeconds } = await rateLimiter.checkLimit(tokenPayload.userId, 'init');
      if (limited) {
        return { error: `Too many submissions. Please wait ${timeLeftSeconds} seconds before trying again.` };
      }

      // 3. Insert record in database with status CREATED
      await clientQuery(
        `INSERT INTO submissions (id, token, user_id, discord_username, creator_id, clip_type, description, bucket, object_key, status, server_id, channel_id, submitted_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          submissionId,
          tokenPayload.tokenId,
          tokenPayload.userId,
          tokenPayload.discordUser,
          creatorId,
          clipType,
          sanitizedDescription,
          config.r2.bucketName || 'dummy-bucket',
          'pending_upload',
          'CREATED',
          tokenPayload.serverId,
          tokenPayload.channelId,
          new Date(),
          new Date()
        ]
      );

      // 4. Write audit log
      await clientQuery(
        `INSERT INTO audit_logs (action, actor_id, actor_username, details, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          'TOKEN_CONSUMPTION_AND_SUBMISSION_INIT',
          tokenPayload.userId,
          tokenPayload.discordUser,
          JSON.stringify({ submissionId, creatorId, clipType }),
          new Date()
        ]
      );

      return { tokenPayload, submissionId };
    });

    if ('error' in result) {
      res.status(400).json({ success: false, message: result.error, requestId });
      return;
    }

    logCtx.info(`Submission record created successfully. ID: ${result.submissionId}`);
    res.status(200).json({ success: true, submissionId: result.submissionId });
  } catch (error: any) {
    logCtx.error(`Failed to initiate submission: ${error.message}`);
    res.status(500).json({ success: false, message: 'Failed to initiate submission.', requestId });
  }
}

// ─── Web Submission Upload ─────────────────────────────────────────────────
export async function handleWebSubmissionUpload(req: Request, res: Response): Promise<void> {
  const requestId = (req as any).requestId || 'unknown';
  const submissionId = req.params.submissionId;
  const logCtx = getLoggerContext(requestId, submissionId).child({ module: 'handleWebSubmissionUpload' });

  try {
    logCtx.info(`Received streaming file upload request for submission`);

    // 1. Enforce body size limits ahead of Busboy streaming
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > MAX_UPLOAD_SIZE) {
      res.status(413).json({ success: false, message: `Request body size limit exceeded. Maximum limit is ${MAX_UPLOAD_SIZE / (1024 * 1024)}MB.`, requestId });
      return;
    }

    // 2. Authenticate & validate session token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Missing authorization token.', requestId });
      return;
    }
    
    const token = authHeader.split(' ')[1];

    // Retrieve submission record and verify CREATED state
    const submissions = await query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
    if (submissions.length === 0) {
      res.status(404).json({ success: false, message: 'Submission record not found.', requestId });
      return;
    }

    const submission = submissions[0];
    uploadCounter.inc({ status: 'attempt', type: submission.clip_type || 'unknown' });
    if (submission.status !== 'CREATED') {
      res.status(400).json({ success: false, message: `Submission is in invalid state: ${submission.status}`, requestId });
      return;
    }

    // Enforce ownership verification matching token payload to submission
    if (submission.token !== token) {
      res.status(403).json({ success: false, message: 'Unauthorized access to submission record.', requestId });
      return;
    }

    // Verify token exists and is not expired
    const tokens = await query('SELECT * FROM upload_tokens WHERE token = $1', [token]);
    if (tokens.length === 0) {
      res.status(401).json({ success: false, message: 'Invalid or missing submission token.', requestId });
      return;
    }
    const tokenRow = tokens[0];
    const expiresAtMs = new Date(tokenRow.expires_at).getTime();
    if (Date.now() > expiresAtMs) {
      res.status(401).json({ success: false, message: 'Your link has expired. Return to Discord and click Submit Clip again.', requestId });
      return;
    }

    // 3. Update status to UPLOADING
    await query('UPDATE submissions SET status = $1, updated_at = $2 WHERE id = $3', ['UPLOADING', new Date(), submissionId]);

    const busboy = Busboy({ 
      headers: req.headers,
      limits: {
        fields: 0,
        files: 1
      }
    });

    let fileUploadPromise: Promise<{ fileUrl: string; sizeBytes: number }> | null = null;
    let originalFilename = '';
    let isUploadAborted = false;
    let abortReason = '';
    let fileKey = '';

    busboy.on('file', (name, fileStream, info) => {
      const { filename, mimeType } = info;
      originalFilename = sanitizeFilename(filename);

      logCtx.info(`Busboy parsing file: "${originalFilename}" (${mimeType}). Direct streaming to R2...`);

      const magicValidator = new MagicByteValidator();
      const validatedStream = fileStream.pipe(magicValidator);
      fileKey = `submissions/${Date.now()}_${submissionId}_${originalFilename}`;

      fileUploadPromise = R2StorageService.uploadStream(
        validatedStream,
        fileKey,
        mimeType,
        MAX_UPLOAD_SIZE
      );

      fileStream.on('error', (err: any) => {
        logCtx.error(`File stream input error: ${err.message}`);
        isUploadAborted = true;
        abortReason = err.message;
      });

      magicValidator.on('error', (err: any) => {
        logCtx.warn(`Magic byte validation check blocked stream: ${err.message}`);
        isUploadAborted = true;
        abortReason = err.message;
      });
    });

    busboy.on('finish', async () => {
      try {
        if (isUploadAborted) {
          uploadCounter.inc({ status: 'failed', type: submission.clip_type || 'unknown' });
          await runTransaction(async (clientQuery) => {
            await clientQuery("UPDATE submissions SET status = 'FAILED', updated_at = $1 WHERE id = $2", [new Date(), submissionId]);
            await clientQuery(
              `INSERT INTO audit_logs (action, actor_id, actor_username, details, created_at)
               VALUES ($1, $2, $3, $4, $5)`,
              ['SUBMISSION_UPLOAD_ABORTED', tokenRow.user_id, tokenRow.discord_user, JSON.stringify({ submissionId, reason: abortReason }), new Date()]
            );
          });
          res.status(400).json({ success: false, message: abortReason || 'Upload stream aborted.', requestId });
          return;
        }

        if (!fileUploadPromise) {
          uploadCounter.inc({ status: 'failed', type: submission.clip_type || 'unknown' });
          await runTransaction(async (clientQuery) => {
            await clientQuery("UPDATE submissions SET status = 'FAILED', updated_at = $1 WHERE id = $2", [new Date(), submissionId]);
            await clientQuery(
              `INSERT INTO audit_logs (action, actor_id, actor_username, details, created_at)
               VALUES ($1, $2, $3, $4, $5)`,
              ['SUBMISSION_UPLOAD_FAILED', tokenRow.user_id, tokenRow.discord_user, JSON.stringify({ submissionId, reason: 'No file provided' }), new Date()]
            );
          });
          res.status(400).json({ success: false, message: 'No file provided.', requestId });
          return;
        }

        const uploadResult = await fileUploadPromise;
        logCtx.info(`R2 upload completed. Key: ${fileKey}`);
        uploadCounter.inc({ status: 'success', type: submission.clip_type || 'unknown' });
        uploadSizeHistogram.observe(uploadResult.sizeBytes);

        // Update database and write audit logs in a transaction
        await runTransaction(async (clientQuery) => {
          await clientQuery(
            `UPDATE submissions 
             SET object_key = $1, size_bytes = $2, original_filename = $3, status = $4, updated_at = $5
             WHERE id = $6`,
            [
              fileKey,
              uploadResult.sizeBytes,
              originalFilename,
              'UPLOADED',
              new Date(),
              submissionId
            ]
          );
          
          await clientQuery(
            `INSERT INTO audit_logs (action, actor_id, actor_username, details, created_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              'SUBMISSION_UPLOAD_FINISHED',
              tokenRow.user_id,
              tokenRow.discord_user,
              JSON.stringify({ submissionId, fileKey, sizeBytes: uploadResult.sizeBytes }),
              new Date()
            ]
          );
        });

        // // Idempotency check before triggering queues
        // const isDuplicate = await AirtableService.isDuplicateSubmission(submissionId);
        // if (isDuplicate) {
        //   logCtx.warn(`Duplicate submission detected. Skipping queue dispatch.`);
        //   res.status(200).json({ success: true, message: 'Submission received successfully.', submissionId });
        //   return;
        // }

        // Fetch active creators to map name
        const activeCreators = await AirtableService.getActiveCreators();
        const creatorName = activeCreators.find(c => c.id === submission.creator_id)?.name || 'Unknown Creator';

        // Prepare payloads
        const submissionPayload: SubmissionPayload = {
          submissionId,
          discordUser: tokenRow.discord_user,
          displayName: tokenRow.display_name,
          userId: tokenRow.user_id,
          creatorId: submission.creator_id,
          clipType: submission.clip_type,
          description: submission.description,
          submittedAt: submission.submitted_at,
          serverId: tokenRow.server_id,
          channelId: tokenRow.channel_id
        };

        // Enqueue sync & notification jobs forwarding requestId correlation ID
        logCtx.info('Enqueuing Airtable write job...');
        await queue.enqueue('airtable_write', {
          submissionPayload,
          fileKey,
          sizeBytes: uploadResult.sizeBytes,
          originalname: originalFilename,
          requestId
        });

        const sizeMb = (uploadResult.sizeBytes / (1024 * 1024)).toFixed(2);
        logCtx.info('Enqueuing Discord Notification job...');
        await queue.enqueue('discord_notify', {
          channelId: tokenRow.channel_id,
          userId: tokenRow.user_id,
          displayName: tokenRow.display_name,
          discordUser: tokenRow.discord_user,
          clipType: submission.clip_type,
          filename: originalFilename,
          sizeMb,
          description: submission.description ? `${creatorName} - ${submission.description}` : `${creatorName}`,
          submissionId,
          requestId
        });

        // Update status to READY_FOR_REVIEW
        await query('UPDATE submissions SET status = $1, updated_at = $2 WHERE id = $3', ['READY_FOR_REVIEW', new Date(), submissionId]);

        res.status(200).json({
          success: true,
          message: 'Your clip has been submitted successfully.',
          submissionId
        });
      } catch (err: any) {
        uploadCounter.inc({ status: 'failed', type: submission.clip_type || 'unknown' });
        logCtx.error(`Failed during upload completion: ${err.message}`, { stack: err.stack });
        await query('UPDATE submissions SET status = $1, updated_at = $2 WHERE id = $3', ['FAILED', new Date(), submissionId]);
        res.status(500).json({ success: false, message: err.message || 'Processing file failed.', requestId });
      }
    });

    req.pipe(busboy);
  } catch (error: any) {
    uploadCounter.inc({ status: 'failed', type: 'unknown' });
    logCtx.error(`Upload error: ${error.message}`);
    res.status(500).json({ success: false, message: 'Upload process initialization failed.', requestId });
  }
}

// ─── Direct Browser to R2 Upload (Presigned URL) ───────────────────────────
export async function handlePresignedUrl(req: Request, res: Response): Promise<void> {
  const requestId = (req as any).requestId || 'unknown';
  const submissionId = req.params.submissionId;
  const { filename, mimeType } = req.body;
  const logCtx = getLoggerContext(requestId, submissionId).child({ module: 'handlePresignedUrl' });

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Missing authorization token.', requestId });
      return;
    }
    const token = authHeader.split(' ')[1];

    const submissions = await query('SELECT * FROM submissions WHERE id = $1', [submissionId]);
    if (submissions.length === 0) {
      res.status(404).json({ success: false, message: 'Submission not found.', requestId });
      return;
    }
    const submission = submissions[0];
    if (submission.token !== token) {
      res.status(403).json({ success: false, message: 'Unauthorized.', requestId });
      return;
    }

    const safeFilename = sanitizeFilename(filename);
    const fileKey = `submissions/${Date.now()}_${submissionId}_${safeFilename}`;
    
    // Update DB with key
    await query('UPDATE submissions SET object_key = $1, original_filename = $2, status = $3, updated_at = $4 WHERE id = $5', 
      [fileKey, safeFilename, 'UPLOADING', new Date(), submissionId]);

    const url = await R2StorageService.generatePresignedUploadUrl(fileKey, mimeType, 3600);
    
    res.status(200).json({ success: true, url, fileKey, originalFilename: safeFilename });
  } catch (err: any) {
    logCtx.error(`Failed to generate presigned URL: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to generate upload URL.', requestId });
  }
}

export async function handleDirectUploadComplete(req: Request, res: Response): Promise<void> {
  const requestId = (req as any).requestId || 'unknown';
  const submissionId = req.params.submissionId;
  const { sizeBytes } = req.body;
  const logCtx = getLoggerContext(requestId, submissionId).child({ module: 'handleDirectUploadComplete' });

  let sub: any = null;
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: 'Missing authorization token.', requestId });
      return;
    }
    const token = authHeader.split(' ')[1];

    const submissions = await query(`
      SELECT s.*, t.discord_user, t.display_name, t.user_id as t_user_id, t.server_id, t.channel_id 
      FROM submissions s 
      JOIN upload_tokens t ON s.token = t.token 
      WHERE s.id = $1`, [submissionId]);

    if (submissions.length === 0) {
      res.status(404).json({ success: false, message: 'Submission not found.', requestId });
      return;
    }
    
    sub = submissions[0];
    if (sub.token !== token) {
      res.status(403).json({ success: false, message: 'Unauthorized.', requestId });
      return;
    }

    await runTransaction(async (clientQuery) => {
      await clientQuery(
        `UPDATE submissions SET size_bytes = $1, status = $2, updated_at = $3 WHERE id = $4`,
        [sizeBytes, 'UPLOADED', new Date(), submissionId]
      );
      await clientQuery(
        `INSERT INTO audit_logs (action, actor_id, actor_username, details, created_at) VALUES ($1, $2, $3, $4, $5)`,
        ['SUBMISSION_UPLOAD_FINISHED_DIRECT', sub.t_user_id, sub.discord_user, JSON.stringify({ submissionId, sizeBytes }), new Date()]
      );
    });

    const activeCreators = await AirtableService.getActiveCreators();
    const creatorName = activeCreators.find(c => c.id === sub.creator_id)?.name || 'Unknown Creator';

    const submissionPayload: SubmissionPayload = {
      submissionId,
      discordUser: sub.discord_user,
      displayName: sub.display_name,
      userId: sub.t_user_id,
      creatorId: sub.creator_id,
      clipType: sub.clip_type,
      description: sub.description,
      submittedAt: sub.submitted_at,
      serverId: sub.server_id,
      channelId: sub.channel_id
    };

    await queue.enqueue('airtable_write', {
      submissionPayload,
      fileKey: sub.object_key,
      sizeBytes,
      originalname: sub.original_filename,
      requestId
    });

    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    await queue.enqueue('discord_notify', {
      channelId: sub.channel_id,
      userId: sub.t_user_id,
      displayName: sub.display_name,
      discordUser: sub.discord_user,
      clipType: sub.clip_type,
      filename: sub.original_filename,
      sizeMb,
      description: sub.description ? `${creatorName} - ${sub.description}` : `${creatorName}`,
      submissionId,
      requestId
    });

    await query('UPDATE submissions SET status = $1, updated_at = $2 WHERE id = $3', ['READY_FOR_REVIEW', new Date(), submissionId]);

    uploadCounter.inc({ status: 'success', type: sub.clip_type || 'unknown' });
    uploadSizeHistogram.observe(Number(sizeBytes));

    res.status(200).json({ success: true, message: 'Direct upload completed successfully.' });
  } catch (err: any) {
    uploadCounter.inc({ status: 'failed', type: (sub && sub.clip_type) || 'unknown' });
    logCtx.error(`Failed to complete direct upload: ${err.message}`);
    res.status(500).json({ success: false, message: 'Failed to complete upload.', requestId });
  }
}

export async function handleMockUploadDirect(req: Request, res: Response): Promise<void> {
  const key = req.query.key as string;
  if (!key) {
    res.status(400).json({ success: false, message: 'Missing key parameter' });
    return;
  }
  
  try {
    const fs = await import('fs');
    const path = await import('path');
    
    const filename = path.basename(key);
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const targetPath = path.join(uploadsDir, filename);
    
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const writeStream = fs.createWriteStream(targetPath);
    req.pipe(writeStream);
    
    writeStream.on('finish', () => {
      logger.info(`[MOCK STORAGE] Direct mock upload complete: ${filename}`);
      res.status(200).send('Upload mock complete');
    });
    
    writeStream.on('error', (err: any) => {
      logger.error(`[MOCK STORAGE] Direct mock upload write error: ${err.message}`);
      res.status(500).send(err.message);
    });
  } catch (err: any) {
    res.status(500).send(err.message);
  }
}

