import { Worker } from 'bullmq';
import { validateConfig, config, WORKER_CONCURRENCY } from './shared/config.js';
import { initDb, closeDb } from './shared/db.js';
import { getRedisClient, closeRedis } from './shared/redis.js';
import { logger } from './shared/logger.js';
import { client } from './bot/client.js';
import { processAirtableSync, processDiscordNotify, NonRetryableError } from './shared/jobs.js';
import { queueProcessingDuration } from './api/monitoring.js';

async function bootstrap() {
  try {
    logger.info('Starting Clip Submission Queue Worker...');
    
    // Validate config
    validateConfig();
    
    // Initialize DB
    await initDb();
    
    // Log in Discord bot client (required for discord_notify embeds)
    if (config.discord.token) {
      logger.info('Logging in Discord Bot client...');
      await client.login(config.discord.token);
    } else {
      logger.warn('DISCORD_TOKEN is missing. Discord bot notifications are disabled.');
    }

    const redis = getRedisClient();
    if (!redis) {
      logger.error('Redis connection is missing. Standalone Worker process requires Redis. Exiting.');
      process.exit(1);
    }

    // Set concurrency to WORKER_CONCURRENCY (1 for initial launch)
    const worker = new Worker(
      'clip_submissions_queue',
      async (job) => {
        const { name, data } = job;
        logger.info(`Worker processing job: ${name} (ID: ${job.id})`);
        
        const startTime = Date.now();
        try {
          if (name === 'airtable_sync') {
            await processAirtableSync(data);
          } else if (name === 'discord_notify') {
            await processDiscordNotify(data);
          } else {
            logger.warn(`Worker received unknown job name: ${name}`);
          }
          const duration = (Date.now() - startTime) / 1000;
          queueProcessingDuration.observe({ job_name: name, status: 'success' }, duration);
        } catch (err: any) {
          const duration = (Date.now() - startTime) / 1000;
          queueProcessingDuration.observe({ job_name: name, status: 'failed' }, duration);
          if (err instanceof NonRetryableError || err.isNonRetryable) {
            logger.error(`Non-retryable unrecoverable error encountered in job ${name} (ID: ${job.id}): ${err.message}. Discarding job.`);
            await job.discard();
          }
          throw err;
        }
      },
      {
        connection: redis,
        concurrency: WORKER_CONCURRENCY,
      }
    );

    worker.on('completed', (job) => {
      logger.info(`Job completed: ${job.name} (ID: ${job.id})`);
    });

    worker.on('failed', (job, err) => {
      logger.error(`Job failed: ${job?.name} (ID: ${job?.id}) - Error: ${err.message}`);
    });

    logger.info(`Queue Worker is online and listening for jobs. Concurrency: ${WORKER_CONCURRENCY}`);

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting Worker graceful shutdown...`);
      try {
        await worker.close();
        logger.info('BullMQ worker drained and closed.');
        await closeDb();
        await closeRedis();
        logger.info('Worker shutdown complete. Exiting.');
        process.exit(0);
      } catch (err) {
        logger.error('Error during Worker shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('Critical failure during Worker bootstrap:', error);
    process.exit(1);
  }
}

bootstrap();
export {};
