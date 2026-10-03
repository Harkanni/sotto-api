import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { redisRateLimitStore } from '../src/auth/rate-limit.js';

/** Just enough of ioredis's MULTI for the store: INCR, EXPIRE NX, PTTL. */
function fakeRedis({ fail = false } = {}): Redis {
  const counts = new Map<string, number>();
  return {
    multi() {
      let key = '';
      const chain = {
        incr(k: string) {
          key = k;
          return chain;
        },
        expire() {
          return chain;
        },
        pttl() {
          return chain;
        },
        async exec() {
          if (fail) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return [
            [null, counts.get(key)],
            [null, 1],
            [null, 42_100],
          ];
        },
      };
      return chain;
    },
  } as unknown as Redis;
}

describe('redisRateLimitStore', () => {
  it('allows up to the limit, then says how long to wait', async () => {
    const store = redisRateLimitStore(fakeRedis());
    const rule = { window: 60, max: 2 };
    expect(await store.consume('ip:/sign-in/magic-link', rule)).toEqual({
      allowed: true,
      retryAfter: null,
    });
    expect((await store.consume('ip:/sign-in/magic-link', rule)).allowed).toBe(true);
    expect(await store.consume('ip:/sign-in/magic-link', rule)).toEqual({
      allowed: false,
      retryAfter: 43,
    });
    // Keys are independent.
    expect((await store.consume('other-ip:/sign-in/magic-link', rule)).allowed).toBe(true);
  });

  it('lets requests through when Redis is down', async () => {
    const store = redisRateLimitStore(fakeRedis({ fail: true }));
    expect(await store.consume('k', { window: 60, max: 1 })).toEqual({
      allowed: true,
      retryAfter: null,
    });
  });
});
