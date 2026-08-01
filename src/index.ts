import { Worker } from 'bullmq';
import { validateConfig, config, WORKER_CONCURRENCY } from './shared/config.js';
import { logger } from './shared/logger.js';
import { startApiServer } from './api/server.js';
import { client } from './bot/client.js';
import { queue } from './api/services/queue.js';
import { initDb, closeDb } from './shared/db.js';
import { getRedisClient, closeRedis } from './shared/redis.js';
import { processAirtableSync, processDiscordNotify, NonRetryableError } from './shared/jobs.js';
import { startViewCheckerInterval } from './api/services/viewChecker.js';

async function bootstrap() {
  try {
    logger.info('Starting Unified (Monolithic) Clip Submission System...');

    // 1. Validate Environment Configurations
    validateConfig();

    // 2. Initialize PostgreSQL/SQLite Database
    await initDb();

    // 3. Recover background persistent queue jobs from any interrupted state
    queue.recoverProcessingJobs();

    // 4. Start the REST API Backend
    logger.info('Initializing REST API server...');
    const server = startApiServer();

    // 5. Start the Discord Bot (if token is available)
    if (config.discord.token) {
      logger.info('Logging in Discord Bot...');
      await client.login(config.discord.token);
    } else {
      logger.warn('DISCORD_TOKEN is not defined. Discord bot functionality is disabled.');
    }

    // 6. Start embedded BullMQ worker if Redis is available
    //    This ensures queued jobs (Airtable writes, Discord notifications)
    //    are processed in-process without needing a separate worker service.
    let embeddedWorker: Worker | null = null;
    const redis = getRedisClient();
    if (redis) {
      logger.info('Starting embedded BullMQ worker for monolith mode...');
      embeddedWorker = new Worker(
        'clip_submissions_queue',
        async (job) => {
          const { name, data } = job;
          logger.info(`[Embedded Worker] Processing job: ${name} (ID: ${job.id})`);

          try {
            if (name === 'airtable_sync') {
              await processAirtableSync(data);
            } else if (name === 'discord_notify') {
              await processDiscordNotify(data);
            } else {
              logger.warn(`[Embedded Worker] Unknown job name: ${name}`);
            }
          } catch (err: any) {
            if (err instanceof NonRetryableError || err.isNonRetryable) {
              logger.error(`[Embedded Worker] Non-retryable error in job ${name} (ID: ${job.id}): ${err.message}. Discarding.`);
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

      embeddedWorker.on('completed', (job) => {
        logger.info(`[Embedded Worker] Job completed: ${job.name} (ID: ${job.id})`);
      });

      embeddedWorker.on('failed', (job, err) => {
        logger.error(`[Embedded Worker] Job failed: ${job?.name} (ID: ${job?.id}) - Error: ${err.message}`);
      });

      logger.info(`Embedded BullMQ worker is online. Concurrency: ${WORKER_CONCURRENCY}`);
    } else {
      logger.info('No Redis configured — jobs will execute in-process via mock queue.');
    }

    // 6.5. Start View Checker & Payout Scheduler
    startViewCheckerInterval();

    // 7. Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting monolith graceful shutdown...`);
      server.close(async () => {
        logger.info('Express server closed.');
        try {
          if (embeddedWorker) {
            await embeddedWorker.close();
            logger.info('Embedded BullMQ worker closed.');
          }
          client.destroy();
          logger.info('Discord client destroyed.');
          await closeDb();
          await closeRedis();
          logger.info('All connections closed. Exiting.');
          process.exit(0);
        } catch (err) {
          logger.error('Error during monolith shutdown:', err);
          process.exit(1);
        }
      });

      setTimeout(() => {
        logger.error('Graceful shutdown timed out. Force exiting.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('Critical failure during Clip Submission System bootstrap:', error);
    process.exit(1);
  }
}

bootstrap();

