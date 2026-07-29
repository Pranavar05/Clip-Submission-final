import { validateConfig, config } from './shared/config.js';
import { logger } from './shared/logger.js';
import { startApiServer } from './api/server.js';
import { client } from './bot/client.js';
import { queue } from './api/services/queue.js';
import { initDb, closeDb } from './shared/db.js';
import { closeRedis } from './shared/redis.js';

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

    // 6. Graceful shutdown
    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting monolith graceful shutdown...`);
      server.close(async () => {
        logger.info('Express server closed.');
        try {
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

