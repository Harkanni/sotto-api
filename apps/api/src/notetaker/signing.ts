import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The notetaker's credentials (ADR 0035), both signed with `MEETING_BOT_SECRET`:
 *
 * - **Bot token** `<assignmentId>.<expires>.<signature>`: what a bot sends its call's audio
 *   with (`Authorization: Bot <token>`). It names one assignment and expires after the call, so
 *   a leaked token reaches nothing else and outlives nothing.
 * - **Webhook signature**: hex HMAC-SHA256 over `<timestamp>.<raw body>`, sent as
 *   `X-Sotto-Signature` with `X-Sotto-Timestamp` (Unix seconds). Five minutes either way, so a
 *   captured request can't be replayed later.
 *
 * Each kind signs with its own prefix, so one can never be passed off as the other.
 */

const TOKEN_PREFIX = 'sotto-bot-token:';
const WEBHOOK_PREFIX = 'sotto-bot-webhook:';
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

function hmac(secret: string, message: string): Buffer {
  return createHmac('sha256', secret).update(message).digest();
}

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signBotToken(secret: string, assignmentId: string, expiresAt: Date): string {
  const expires = Math.floor(expiresAt.getTime() / 1000);
  const body = `${assignmentId}.${expires}`;
  return `${body}.${hmac(secret, TOKEN_PREFIX + body).toString('base64url')}`;
}

/** The assignment a token is for, or null if it's malformed, forged or expired. */
export function verifyBotToken(
  secret: string,
  token: string,
  now = Date.now(),
): { assignmentId: string } | null {
  const match = /^([\w-]{1,64})\.(\d{1,12})\.([\w-]{43})$/.exec(token);
  if (!match) return null;
  const [, assignmentId, expires, signature] = match as unknown as [string, string, string, string];
  const expected = hmac(secret, `${TOKEN_PREFIX}${assignmentId}.${expires}`);
  if (!sameBytes(Buffer.from(signature, 'base64url'), expected)) return null;
  if (Number(expires) * 1000 <= now) return null;
  return { assignmentId };
}

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return hmac(secret, `${WEBHOOK_PREFIX}${timestamp}.${rawBody}`).toString('hex');
}

/** True only for a correct signature made within the tolerance of `now`. */
export function verifyWebhook(
  secret: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  rawBody: string,
  now = Date.now(),
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(headers.signature ?? '')) {
    return false;
  }
  if (Math.abs(now - timestamp * 1000) > WEBHOOK_TOLERANCE_MS) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), 'hex');
  return sameBytes(Buffer.from(headers.signature!, 'hex'), expected);
}
