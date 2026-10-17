import { describe, expect, it } from 'vitest';
import {
  WEBHOOK_TOLERANCE_MS,
  signBotToken,
  signWebhook,
  verifyBotToken,
  verifyWebhook,
} from '../src/notetaker/signing.js';

const SECRET = 'a-test-secret-that-is-long-enough-1234';
const NOW = Date.parse('2026-10-17T09:00:00Z');

describe('bot tokens', () => {
  it('name one assignment until they expire', () => {
    const token = signBotToken(SECRET, 'ba_123', new Date(NOW + 60_000));
    expect(verifyBotToken(SECRET, token, NOW)).toEqual({ assignmentId: 'ba_123' });
    expect(verifyBotToken(SECRET, token, NOW + 60_000)).toBeNull();
  });

  it('refuse a forged, altered or foreign token', () => {
    const token = signBotToken(SECRET, 'ba_123', new Date(NOW + 60_000));
    const [, expires, signature] = token.split('.');
    expect(verifyBotToken(SECRET, `ba_999.${expires}.${signature}`, NOW)).toBeNull();
    expect(verifyBotToken(SECRET, `ba_123.${Number(expires) + 3600}.${signature}`, NOW)).toBeNull();
    expect(verifyBotToken('another-secret-entirely-1234567890', token, NOW)).toBeNull();
    expect(verifyBotToken(SECRET, 'not a token', NOW)).toBeNull();
    expect(verifyBotToken(SECRET, '', NOW)).toBeNull();
  });
});

describe('webhook signatures', () => {
  const body = JSON.stringify({ assignmentId: 'ba_123', event: 'in_call' });
  const ts = Math.floor(NOW / 1000);

  it('accept the exact body, signed within five minutes', () => {
    const signature = signWebhook(SECRET, ts, body);
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature }, body, NOW)).toBe(true);
    expect(
      verifyWebhook(
        SECRET,
        { timestamp: String(ts), signature },
        body,
        NOW + WEBHOOK_TOLERANCE_MS - 1_000,
      ),
    ).toBe(true);
  });

  it('refuse a changed body, an old or future timestamp, or a missing signature', () => {
    const signature = signWebhook(SECRET, ts, body);
    const tampered = body.replace('in_call', 'left');
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature }, tampered, NOW)).toBe(false);
    expect(
      verifyWebhook(
        SECRET,
        { timestamp: String(ts), signature },
        body,
        NOW + WEBHOOK_TOLERANCE_MS + 1_000,
      ),
    ).toBe(false);
    expect(
      verifyWebhook(SECRET, { timestamp: String(ts), signature }, body, NOW - 10 * 60_000),
    ).toBe(false);
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature: undefined }, body, NOW)).toBe(
      false,
    );
    expect(verifyWebhook(SECRET, { timestamp: 'soon', signature }, body, NOW)).toBe(false);
  });

  it('never accepts a bot token as a webhook signature, or the reverse', () => {
    const token = signBotToken(SECRET, 'ba_123', new Date(NOW + 60_000));
    expect(verifyWebhook(SECRET, { timestamp: String(ts), signature: token }, body, NOW)).toBe(
      false,
    );
    const signature = signWebhook(SECRET, ts, 'ba_123.1792234800');
    expect(verifyBotToken(SECRET, `ba_123.1792234800.${signature}`, NOW)).toBeNull();
  });
});
