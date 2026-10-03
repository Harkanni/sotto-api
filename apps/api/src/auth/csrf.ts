import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-session CSRF tokens (PLAN → API: "writes need the session cookie plus a CSRF token").
 *
 * The token is an HMAC of the session id under the server secret, so nothing is stored: any
 * api instance can check it, it changes with every session, and it dies with the session.
 * The web reads it from GET /me (a same-origin read another site can't make) and sends it as
 * `X-CSRF-Token` on every write. Nest's cross-origin protection runs in front as a second layer.
 */

export const CSRF_HEADER = 'x-csrf-token';

export function csrfToken(secret: string, sessionId: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

export function verifyCsrfToken(secret: string, sessionId: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || !presented) return false;
  const expected = Buffer.from(csrfToken(secret, sessionId));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
