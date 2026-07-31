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

export async function getCachedValue<T>(key: string): Promise<T | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : null;
  } catch (err: any) {
    logger.error(`Redis cache get error for key ${key}: ${err.message}`);
    return null;
  }
}

export async function setCachedValue(key: string, value: any, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err: any) {
    logger.error(`Redis cache set error for key ${key}: ${err.message}`);
  }
}

export async function invalidateCache(key: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(key);
  } catch (err: any) {
    logger.error(`Redis cache del error for key ${key}: ${err.message}`);
  }
}


