import { validateConfig, config } from './shared/config.js';
import { initDb, closeDb } from './shared/db.js';
import { client } from './bot/client.js';
import { logger } from './shared/logger.js';
import { closeRedis } from './shared/redis.js';

async function bootstrap() {
  try {
    logger.info('Starting decoupled Discord Bot listener...');
    validateConfig();
    await initDb();
    
    if (config.discord.token) {
      logger.info('Logging in Discord Bot client...');
      await client.login(config.discord.token);
    } else {
      logger.error('DISCORD_TOKEN is missing. Bot cannot start. Exiting.');
      process.exit(1);
    }

    const gracefulShutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Starting Bot graceful shutdown...`);
      try {
        client.destroy();
        logger.info('Discord client destroyed.');
        await closeDb();
        await closeRedis();
        logger.info('Bot shutdown complete. Exiting.');
        process.exit(0);
      } catch (err) {
        logger.error('Error during Bot shutdown:', err);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('Critical failure during Bot bootstrap:', error);
    process.exit(1);
  }
}

bootstrap();
export {};
