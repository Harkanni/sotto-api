import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { APP_OPTIONS, configureApp } from '../src/bootstrap.js';
import { DEPENDENCY_CHECKS, type DependencyCheck } from '../src/health/checks.js';

const check = (name: string, healthy: boolean): DependencyCheck => ({
  name,
  check: async () => {
    if (!healthy) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
  },
});

async function boot(checks: DependencyCheck[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DEPENDENCY_CHECKS)
    .useValue(checks)
    .compile();
  const app = moduleRef.createNestApplication({ ...APP_OPTIONS, logger: false });
  configureApp(app);
  await app.init();
  return app;
}

describe('api routes', () => {
  let app: INestApplication | undefined;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.APP_VERSION = '1.2.3';
  });

  afterEach(async () => {
    await app?.close();
  });

  it('GET /healthz is always ok', async () => {
    app = await boot([check('database', false)]);
    await request(app.getHttpServer()).get('/healthz').expect(200, { status: 'ok' });
  });

  it('GET /readyz is 503 when a dependency is down', async () => {
    app = await boot([check('database', true), check('queue', false)]);
    const res = await request(app.getHttpServer()).get('/readyz').expect(503);
    expect(res.body.checks.queue.ok).toBe(false);
  });

  it('GET /readyz is 200 when everything answers', async () => {
    app = await boot([check('database', true)]);
    await request(app.getHttpServer()).get('/readyz').expect(200);
  });

  it('GET /api/v1/status summarises the build and dependencies', async () => {
    app = await boot([check('database', true), check('redis', false)]);
    const res = await request(app.getHttpServer()).get('/api/v1/status').expect(200);
    expect(res.body).toMatchObject({
      service: 'sotto-api',
      version: '1.2.3',
      ready: false,
      checks: { database: true, redis: false },
    });
  });

  it('does not advertise the framework', async () => {
    app = await boot([check('database', true)]);
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
