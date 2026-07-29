import { EmbedBuilder } from 'discord.js';
import { client } from '../bot/client.js';
import { AirtableService } from '../api/services/airtable.js';
import { R2StorageService } from '../api/services/storage.js';
import { SIGNED_URL_EXPIRY } from './config.js';
import { logger } from './logger.js';

export class NonRetryableError extends Error {
  public readonly isNonRetryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export async function processAirtableSync(payload: any): Promise<void> {
  const { submissionPayload, fileKey, sizeBytes, originalname, requestId } = payload;
  const traceMsg = requestId ? ` [Req: ${requestId}]` : '';
  logger.info(`Processing Airtable sync job for submission ${submissionPayload.submissionId}${traceMsg}`);
  
  // Generate short-lived signed URL for Airtable database reference
  const signedUrl = await R2StorageService.generatePresignedUrl(fileKey, SIGNED_URL_EXPIRY);
  
  await AirtableService.saveSubmissionRecord(submissionPayload, signedUrl, sizeBytes, originalname);
}

export async function processDiscordNotify(payload: any): Promise<void> {
  const { channelId, userId, displayName, discordUser, clipType, filename, sizeMb, description, submissionId, requestId } = payload;
  const traceMsg = requestId ? ` [Req: ${requestId}]` : '';
  
  logger.info(`Processing Discord notification job for submission ${submissionId}${traceMsg}`);
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) {
      throw new NonRetryableError(`Channel ID ${channelId} does not exist or cannot be fetched.`);
    }
    
    if ('send' in channel) {
      const notifyEmbed = new EmbedBuilder()
        .setTitle('✅ New Clip Submitted')
        .setDescription(`<@${userId}> has successfully submitted a new clip via the web portal.`)
        .addFields(
          { name: 'Submission ID', value: `\`${submissionId}\``, inline: true },
          { name: 'Status', value: '`Pending Approval`', inline: true }
        )
        .setColor('#5865F2')
        .setTimestamp();

      await (channel as any).send({ embeds: [notifyEmbed] });
      logger.info(`Discord notification sent successfully for ID: ${submissionId}${traceMsg}`);
    } else {
      throw new NonRetryableError(`Channel ID ${channelId} is not a text channel and cannot receive messages.`);
    }
  } catch (err: any) {
    const errMsg = err.message || '';
    const errCode = err.code;

    // Detect permanent Discord API errors
    const isPermanentDiscordError = 
      errCode === 10003 || // Unknown Channel
      errCode === 50001 || // Missing Access
      errCode === 50013 || // Missing Permissions
      errCode === 10004 || // Unknown Guild
      errCode === 50007 || // Cannot send messages to this user
      errMsg.includes('Unknown Channel') ||
      errMsg.includes('Missing Access') ||
      errMsg.includes('Missing Permissions') ||
      err instanceof NonRetryableError;

    if (isPermanentDiscordError) {
      logger.error(`Non-retryable Discord error for job ID: ${submissionId}${traceMsg} - ${errMsg}. Rescheduling aborted.`);
      throw new NonRetryableError(`Unrecoverable Discord notification failure: ${errMsg}`);
    }

    throw err; // Allow other errors to trigger backoff retries
  }
}

export async function executeMockJob(name: string, payload: any): Promise<void> {
  if (name === 'airtable_sync') {
    await processAirtableSync(payload);
  } else if (name === 'discord_notify') {
    await processDiscordNotify(payload);
  } else {
    throw new Error(`Unknown job name: ${name}`);
  }
}

