import { Queue } from 'bullmq';
import { getRedisClient } from '../../shared/redis.js';
import { config } from '../../shared/config.js';
import { logger } from '../../shared/logger.js';
import { executeMockJob } from '../../shared/jobs.js';

let bullQueue: Queue | null = null;
const redis = getRedisClient();

if (redis) {
  logger.info('Initializing BullMQ Queue with Redis...');
  bullQueue = new Queue('clip_submissions_queue', { connection: redis });
} else {
  logger.info('[MOCK QUEUE] Redis is not configured. Falling back to in-process mock queue.');
}

class SubmissionQueue {
  /**
   * Enqueues a new background job.
   */
  public async enqueue(type: string, payload: any, maxAttempts = 5): Promise<string> {
    const jobName = type === 'airtable_write' ? 'airtable_sync' : type;
    
    // Extract submission ID deterministically to prevent duplicates
    const subId = payload.submissionId || payload.submissionPayload?.submissionId;
    const jobId = subId ? `${jobName}:${subId}` : `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    if (bullQueue) {
      await bullQueue.add(jobName, payload, {
        jobId,
        attempts: maxAttempts,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
      });
      logger.info(`Enqueued BullMQ job: ${jobName} (ID=${jobId})`);
    } else {
      logger.info(`[MOCK QUEUE] Enqueuing job in-process: ${jobName} (ID=${jobId})`);
      setTimeout(async () => {
        try {
          await executeMockJob(jobName, payload);
        } catch (error) {
          logger.error(`[MOCK QUEUE] Job ${jobName} failed in-process:`, error);
        }
      }, 500);
    }
    return jobId;
  }

  /**
   * Resets active locks (no-op in BullMQ as Redis persistent queue manages this).
   */
  public recoverProcessingJobs(): void {
    logger.info('BullMQ / Mock Queue recovery: No manual recovery required.');
  }

  /**
   * Returns dummy queue stats for health checks.
   */
  public getStats(): { pending: number; processing: number; completed: number; dlq: number } {
    return { pending: 0, processing: 0, completed: 0, dlq: 0 };
  }
}

export const queue = new SubmissionQueue();
export { NonRetryableError } from '../../shared/jobs.js';
