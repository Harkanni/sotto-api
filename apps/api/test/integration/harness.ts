/**
 * Integration tests boot the real api against a real Postgres: one fresh database per test
 * file, built from the committed migrations, so every test sees exactly what production runs.
 *
 * Needs TEST_DATABASE_URL (any database on the server; it's only used to create and drop the
 * per-file ones). CI provides it from a service container; locally `pnpm deps:up` and:
 *   TEST_DATABASE_URL=postgresql://sotto:sotto@localhost:5432/postgres pnpm test
 * Without it the integration files skip, unless REQUIRE_INTEGRATION=1 (CI), where they fail.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import pg from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { APP_OPTIONS, configureApp } from '../../src/bootstrap.js';
import { DEPENDENCY_CHECKS } from '../../src/health/checks.js';
import { Mailer, type MailMessage } from '../../src/mail/mailer.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const APP_URL = 'http://sotto.test';

if (!TEST_DATABASE_URL && process.env.REQUIRE_INTEGRATION === '1') {
  throw new Error('REQUIRE_INTEGRATION=1 but TEST_DATABASE_URL is not set');
}

/** Skip the suite when there is no database to run against. */
export const withDatabase = !TEST_DATABASE_URL;

const MIGRATIONS = new URL('../../../../packages/db/prisma/migrations/', import.meta.url);

/** Creates an empty database and applies every migration in order. */
export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const admin = new URL(TEST_DATABASE_URL!);
  const name = `sotto_it_${randomBytes(5).toString('hex')}`;
  const root = new pg.Client({ connectionString: admin.toString() });
  await root.connect();
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();

  const url = new URL(admin.toString());
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  const folders = readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await db.query(readFileSync(new URL(`${folder}/migration.sql`, MIGRATIONS), 'utf8'));
  }
  await db.end();

  return {
    url: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: admin.toString() });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}

/** Keeps every email instead of sending it. */
export class CapturingMailer extends Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** The last link sent to `to` (sign-in or invite), as a path on the app's origin. */
  lastLink(to: string): string {
    const message = [...this.sent].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase());
    if (!message) throw new Error(`No email to ${to}`);
    const url = /https?:\/\/\S+/.exec(message.text)?.[0];
    if (!url) throw new Error(`No link in the email to ${to}`);
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  }
}

export interface TestApp {
  app: INestApplication;
  mailer: CapturingMailer;
  databaseUrl: string;
  close: () => Promise<void>;
}

/** Boots the api the way main.ts does, with mail captured and dependency checks stubbed. */
export async function bootApp(): Promise<TestApp> {
  const database = await createTestDatabase();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: database.url,
    APP_URL,
    AUTH_RATE_LIMIT: 'off',
    SMTP_URL: '',
  });
  const mailer = new CapturingMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(Mailer)
    .useValue(mailer)
    .overrideProvider(DEPENDENCY_CHECKS)
    .useValue([])
    .compile();
  const app = moduleRef.createNestApplication({ ...APP_OPTIONS, logger: false });
  configureApp(app);
  await app.init();
  return {
    app,
    mailer,
    databaseUrl: database.url,
    close: async () => {
      await app.close();
      await database.drop();
    },
  };
}

/** A browser-like client: keeps cookies, sends the app's Origin, remembers the CSRF token. */
export class Person {
  readonly agent: ReturnType<typeof request.agent>;
  csrf = '';

  constructor(
    private readonly test: TestApp,
    readonly email: string,
  ) {
    this.agent = request.agent(test.app.getHttpServer());
  }

  /** Signs in with a magic link (signing up if new) and loads the CSRF token. */
  async signIn(): Promise<request.Response> {
    await this.agent
      .post('/api/auth/sign-in/magic-link')
      .set('origin', APP_URL)
      .send({ email: this.email, callbackURL: '/home', newUserCallbackURL: '/welcome' })
      .expect(200);
    const verified = await this.agent.get(this.test.mailer.lastLink(this.email)).expect(302);
    await this.refresh();
    return verified;
  }

  async refresh(): Promise<void> {
    const me = await this.agent.get('/api/v1/me').expect(200);
    this.csrf = me.body.csrfToken;
  }

  get(path: string) {
    return this.agent.get(path);
  }

  post(path: string, body?: object) {
    return this.write(this.agent.post(path), body);
  }

  patch(path: string, body?: object) {
    return this.write(this.agent.patch(path), body);
  }

  put(path: string, body?: object) {
    return this.write(this.agent.put(path), body);
  }

  delete(path: string) {
    return this.write(this.agent.delete(path));
  }

  private write(req: request.Test, body?: object) {
    req.set('origin', APP_URL).set('sec-fetch-site', 'same-origin').set('x-csrf-token', this.csrf);
    return body === undefined ? req : req.send(body);
  }
}
