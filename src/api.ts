import { validateConfig } from './shared/config.js';
import { initDb, closeDb } from './shared/db.js';
import { startApiServer } from './api/server.js';
import { logger } from './shared/logger.js';
import { closeRedis } from './shared/redis.js';

async function bootstrap() {
  try {
    logger.info('Starting decoupled REST API server...');
    validateConfig();
    await initDb();
    const server = startApiServer();

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting API server graceful shutdown...`);
      server.close(async () => {
        logger.info('Express server closed.');
        try {
          await closeDb();
          await closeRedis();
          logger.info('Connections closed cleanly. Exiting process.');
          process.exit(0);
        } catch (err) {
          logger.error('Error during database/redis connection shutdown:', err);
          process.exit(1);
        }
      });

      // Force exit after 10s if not clean
      setTimeout(() => {
        logger.error('Graceful shutdown timed out. Force exiting.');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('Critical failure during API bootstrap:', error);
    process.exit(1);
  }
}

bootstrap();
export {};
