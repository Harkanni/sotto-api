import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PaystackProvider,
  TestPaymentProvider,
  paymentProviderFrom,
  periodEndFrom,
} from '../src/billing/payments.js';

describe('payment providers', () => {
  it('uses the labelled stand-in with no key, and refuses live keys unless allowed', () => {
    expect(paymentProviderFrom({ BILLING_ALLOW_LIVE: false })).toBeInstanceOf(TestPaymentProvider);
    expect(
      paymentProviderFrom({ PAYSTACK_SECRET_KEY: 'sk_test_x', BILLING_ALLOW_LIVE: false }),
    ).toMatchObject({ id: 'paystack', testMode: true });
    expect(() =>
      paymentProviderFrom({ PAYSTACK_SECRET_KEY: 'sk_live_x', BILLING_ALLOW_LIVE: false }),
    ).toThrow(/live key/);
    expect(
      paymentProviderFrom({ PAYSTACK_SECRET_KEY: 'sk_live_x', BILLING_ALLOW_LIVE: true }),
    ).toMatchObject({ testMode: false });
  });

  it('only trusts a webhook signed over the exact bytes', () => {
    const p = new PaystackProvider({ secretKey: 'sk_test_k', planCodes: {} });
    const raw = Buffer.from(
      '{"event":"subscription.disable","data":{"subscription_code":"SUB_1"}}',
    );
    const sig = createHmac('sha512', 'sk_test_k').update(raw).digest('hex');
    expect(p.parseWebhook(raw, { 'x-paystack-signature': sig })).toMatchObject({
      type: 'subscription.cancelled',
      subscriptionCode: 'SUB_1',
      ended: true,
    });
    const reordered = Buffer.from(
      '{"data":{"subscription_code":"SUB_1"},"event":"subscription.disable"}',
    );
    expect(p.parseWebhook(reordered, { 'x-paystack-signature': sig })).toBeNull();
    expect(p.parseWebhook(raw, {})).toBeNull();
  });

  it('ends a period a month or a year on', () => {
    const start = new Date('2026-01-31T00:00:00Z');
    expect(periodEndFrom(start, 'yearly').toISOString()).toBe('2027-01-31T00:00:00.000Z');
    expect(periodEndFrom(new Date('2026-10-10T00:00:00Z'), 'monthly').toISOString()).toBe(
      '2026-11-10T00:00:00.000Z',
    );
  });
});
