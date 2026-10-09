import { aiEnv } from '@sotto/ai';
import { baseEnv } from '@sotto/config';
import { storageEnv } from '@sotto/storage';
import { z } from 'zod';

/**
 * A fixed secret for local development and tests only. Production refuses to start without its
 * own AUTH_SECRET (see the refinement below), so this can never sign a real session.
 */
export const DEV_AUTH_SECRET = 'sotto-local-development-secret-not-for-production';

/** An empty variable (`KEY=` in .env) counts as unset. */
const blankAsUnset = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optional = z.preprocess(blankAsUnset, z.string().trim().optional());

export const apiEnv = baseEnv
  .extend({
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    RABBITMQ_URL: z.string().min(1).default('amqp://sotto:sotto@localhost:5672'),

    /** The public origin people use (the web app). /api/auth/* is served on it too. */
    APP_URL: z.url().default('http://localhost:3000'),
    /** Signs session cookies and CSRF tokens; encrypts OAuth tokens. 32+ characters. */
    AUTH_SECRET: z.preprocess(blankAsUnset, z.string().min(32).optional()),
    /** Rate limits on /api/auth (Redis). Off by default outside production. */
    AUTH_RATE_LIMIT: z.preprocess(blankAsUnset, z.enum(['on', 'off']).optional()),

    /** Any SMTP server: Mailpit locally (smtp://localhost:1025), SES or another provider later. */
    SMTP_URL: optional,
    MAIL_FROM: z.string().min(3).default('Sotto <no-reply@sotto.local>'),

    /** Google and Microsoft sign-in appear only when their credentials are set. */
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    MICROSOFT_CLIENT_ID: optional,
    MICROSOFT_CLIENT_SECRET: optional,
    /** "common" (any Microsoft account), "organizations", or one tenant's id. */
    MICROSOFT_TENANT_ID: z.string().default('common'),

    /** Object storage (S3 / SeaweedFS): see packages/storage. */
    ...storageEnv.shape,
    /** Embeddings for searching, and the model that answers in Ask: see packages/ai. */
    ...aiEnv.shape,
    /** Questions one person may ask per minute (each may call a model). */
    ASK_RATE_PER_MINUTE: z.coerce.number().int().positive().default(20),
    /** The largest file anyone may upload. Recordings run long; 2 GiB covers hours of audio. */
    UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(2 * 1024 ** 3),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.AUTH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message: 'is required in production (32+ random characters)',
      });
    }
    if (env.AUTH_SECRET === DEV_AUTH_SECRET && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_SECRET'],
        message: 'must not be the development secret in production',
      });
    }
  })
  .transform((env) => ({
    ...env,
    AUTH_SECRET: env.AUTH_SECRET ?? DEV_AUTH_SECRET,
    AUTH_RATE_LIMIT: env.AUTH_RATE_LIMIT ?? (env.NODE_ENV === 'production' ? 'on' : 'off'),
  }));

export type ApiConfig = z.infer<typeof apiEnv>;

/** Injection token for the validated config object. */
export const APP_CONFIG = Symbol('APP_CONFIG');
