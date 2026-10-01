import { describe, expect, it } from 'vitest';
import type { DependencyCheck } from '../src/health/checks.js';
import { HealthService } from '../src/health/health.service.js';

const ok = (name: string): DependencyCheck => ({ name, check: async () => undefined });
const failing = (name: string, error: Error): DependencyCheck => ({
  name,
  check: async () => {
    throw error;
  },
});
const hanging = (name: string): DependencyCheck => ({
  name,
  check: () => new Promise<void>(() => undefined),
});

describe('HealthService', () => {
  it('is ready when every dependency answers', async () => {
    const result = await new HealthService([ok('database'), ok('redis')]).readiness();
    expect(result.ready).toBe(true);
    expect(result.checks.database?.ok).toBe(true);
  });

  it('reports the failing dependency by code, never by message', async () => {
    const error = Object.assign(new Error('connect to postgresql://u:secret@db failed'), {
      code: 'ECONNREFUSED',
    });
    const result = await new HealthService([ok('redis'), failing('database', error)]).readiness();
    expect(result.ready).toBe(false);
    expect(result.checks.database).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('times out a dependency that never answers', async () => {
    const result = await new HealthService([hanging('queue')]).readiness(50);
    expect(result.checks.queue).toMatchObject({ ok: false, error: 'TIMEOUT' });
  });
});
