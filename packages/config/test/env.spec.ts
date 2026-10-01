import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseEnv, EnvError, loadEnv } from '../src/index.js';

describe('loadEnv', () => {
  const schema = baseEnv.extend({ PORT: z.coerce.number().default(4000), SECRET: z.string().min(8) });

  it('applies defaults and coerces numbers', () => {
    const env = loadEnv(schema, { SECRET: 'abcdefgh', PORT: '5000' });
    expect(env.PORT).toBe(5000);
    expect(env.NODE_ENV).toBe('development');
  });

  it('lists every problem without echoing values', () => {
    try {
      loadEnv(schema, { SECRET: 'zq9', NODE_ENV: 'staging' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      const message = (err as EnvError).message;
      expect(message).toContain('SECRET');
      expect(message).toContain('NODE_ENV');
      expect(message).not.toContain('zq9');
    }
  });
});
