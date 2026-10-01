import { baseEnv } from '@sotto/config';
import { z } from 'zod';

export const apiEnv = baseEnv.extend({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  RABBITMQ_URL: z.string().min(1).default('amqp://sotto:sotto@localhost:5672'),
});

export type ApiConfig = z.infer<typeof apiEnv>;

/** Injection token for the validated config object. */
export const APP_CONFIG = Symbol('APP_CONFIG');
