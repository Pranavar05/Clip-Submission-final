import { getRedisClient } from './redis.js';
import { config } from './config.js';
import { logger } from './logger.js';

class RedisRateLimiter {
  // In-memory fallback map if Redis is not configured
  private fallbackMap = new Map<string, number[]>();

  /**
   * Checks if a user is currently rate limited and optionally adds a submission timestamp.
   */
  public async checkLimit(
    userId: string,
    action = 'submission'
  ): Promise<{ limited: boolean; timeLeftSeconds: number }> {
    const redis = getRedisClient();
    const key = `ratelimit:${action}:${userId}`;
    const now = Date.now();
    const windowMs = config.limits.rateLimitWindowMs;
    const maxSubmissions = config.limits.rateLimitMaxSubmissions;

    if (redis) {
      try {
        const windowStart = now - windowMs;
        const pipeline = redis.pipeline();
        pipeline.zremrangebyscore(key, '-inf', windowStart);
        pipeline.zcard(key);
        pipeline.zrange(key, 0, 0, 'WITHSCORES');
        
        const results = await pipeline.exec();
        if (!results) {
          throw new Error('Pipeline execution failed');
        }
        
        // results is an array of [error, result]
        const zcardResult = results[1][1] as number;
        const oldestRange = results[2][1] as string[]; // e.g., ["timestamp"] or []

        if (zcardResult >= maxSubmissions) {
          const oldestTime = oldestRange.length > 0 ? parseInt(oldestRange[0], 10) : windowStart;
          const timeLeftMs = windowMs - (now - oldestTime);
          const timeLeftSeconds = Math.max(1, Math.ceil(timeLeftMs / 1000));
          return { limited: true, timeLeftSeconds };
        }

        // Under limit: add current timestamp
        await redis.zadd(key, now.toString(), now.toString());
        await redis.expire(key, Math.ceil(windowMs / 1000));
        return { limited: false, timeLeftSeconds: 0 };
      } catch (err) {
        logger.error('Redis RateLimiter error, falling back to memory:', err);
      }
    }

    // MEMORY FALLBACK
    const timestamps = this.fallbackMap.get(key) || [];
    const windowStart = now - windowMs;
    const active = timestamps.filter(ts => ts > windowStart);
    
    this.fallbackMap.set(key, active);

    if (active.length >= maxSubmissions) {
      const oldestTime = active[0];
      const timeLeftMs = windowMs - (now - oldestTime);
      const timeLeftSeconds = Math.max(1, Math.ceil(timeLeftMs / 1000));
      return { limited: true, timeLeftSeconds };
    }

    active.push(now);
    this.fallbackMap.set(key, active);
    return { limited: false, timeLeftSeconds: 0 };
  }
}

export const rateLimiter = new RedisRateLimiter();
