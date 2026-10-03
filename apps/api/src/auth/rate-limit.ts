import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/** The shape Better Auth asks of a rate-limit store: one atomic check-and-count per request. */
export interface RateLimitStore {
  consume(
    key: string,
    rule: { window: number; max: number },
  ): Promise<{ allowed: boolean; retryAfter: number | null }>;
}

const log = new Logger('rate-limit');

/**
 * Fixed-window counters in Redis, shared by every api instance (brief §11: "rate limiting in
 * Redis … stricter on auth routes"). INCR, EXPIRE NX and PTTL run in one MULTI, so concurrent
 * requests can't all slip past a stale count.
 *
 * If Redis can't be reached, requests are allowed (and the failure is logged by code only):
 * a cache outage shouldn't lock every person out of signing in.
 */
export function redisRateLimitStore(redis: Redis, prefix = 'rl:auth:'): RateLimitStore {
  return {
    async consume(key, { window, max }) {
      const k = `${prefix}${key}`;
      try {
        const results = await redis.multi().incr(k).expire(k, window, 'NX').pttl(k).exec();
        if (!results) return { allowed: true, retryAfter: null };
        const count = Number(results[0]?.[1] ?? 0);
        const ttlMs = Number(results[2]?.[1] ?? window * 1000);
        if (count <= max) return { allowed: true, retryAfter: null };
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttlMs / 1000)) };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        log.warn(`store unavailable (${typeof code === 'string' ? code : 'error'}); allowing`);
        return { allowed: true, retryAfter: null };
      }
    },
  };
}
