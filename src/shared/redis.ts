import Redis from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';

let redisInstance: Redis | null = null;

export function getRedisClient(): Redis | null {
  if (!config.redisUrl) {
    return null;
  }
  
  if (!redisInstance) {
    logger.info('Initializing Redis connection client...');
    redisInstance = new Redis(config.redisUrl, {
      maxRetriesPerRequest: null, // Required by BullMQ
    });
    
    redisInstance.on('connect', () => {
      logger.info('Redis client connected successfully.');
    });
    
    redisInstance.on('error', (err) => {
      logger.error('Redis connection error:', err);
    });
  }
  
  return redisInstance;
}

export async function closeRedis(): Promise<void> {
  if (redisInstance) {
    logger.info('Closing Redis client connection...');
    try {
      await redisInstance.quit();
    } catch (err) {
      // ignore
    }
    redisInstance = null;
  }
}

