/**
 * Payments behind one interface (ADR 0004: Paystack first, Stripe later). The api never sees a
 * card: checkout happens on the provider's page, and the api learns the result by verifying the
 * transaction itself (never trusting the browser's redirect) and from signed webhooks.
 *
 * Linking a payment to a workspace: checkout puts the workspace in the transaction's metadata;
 * `confirm` verifies the transaction with the provider and reads it back. Webhooks then only
 * update subscriptions already linked, because Paystack's subscription events don't carry
 * metadata.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PlanId } from '@sotto/contracts';

export type Interval = 'monthly' | 'yearly';
export type PaidPlan = Extract<PlanId, 'PRO' | 'BUSINESS'>;

/** What a verified payment means for a workspace. */
export interface Activation {
  workspaceId: string;
  plan: PaidPlan;
  interval: Interval;
  customerRef: string | null;
  /** The provider's subscription; null until the provider has created it. */
  externalId: string | null;
  periodEnd: Date;
}

/** Webhooks, reduced to what Sotto acts on. `id` makes a retried delivery a no-op. */
export type BillingWebhook =
  | { id: string; type: 'charge.success'; reference: string; subscriptionCode: string | null }
  | {
      id: string;
      type: 'subscription.create';
      subscriptionCode: string;
      customerRef: string;
      planCode: string;
      periodEnd: Date | null;
    }
  | { id: string; type: 'invoice.paid'; subscriptionCode: string; periodEnd: Date | null }
  | { id: string; type: 'invoice.payment_failed'; subscriptionCode: string }
  | { id: string; type: 'subscription.cancelled'; subscriptionCode: string; ended: boolean }
  | { id: string; type: 'ignored'; event: string };

export interface PaymentProvider {
  readonly id: 'paystack' | 'test';
  /** Test mode: no real money moves. The UI says so. */
  readonly testMode: boolean;
  checkout(input: {
    workspaceId: string;
    plan: PaidPlan;
    interval: Interval;
    email: string;
    callbackUrl: string;
  }): Promise<{ url: string; reference: string }>;
  /** Verifies a finished checkout with the provider; null if it isn't a successful payment. */
  confirm(reference: string): Promise<Activation | null>;
  /** A page where the owner updates the card or cancels; null when the provider has none. */
  manageUrl(externalId: string): Promise<string | null>;
  /** Checks a webhook's signature on the exact bytes received; null if it doesn't match. */
  parseWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): BillingWebhook | null;
}

export class PaymentError extends Error {
  constructor(
    readonly code: 'provider_unreachable' | 'provider_refused' | 'plan_not_configured',
    readonly status?: number,
  ) {
    super(code);
    this.name = 'PaymentError';
  }
}

export function periodEndFrom(start: Date, interval: Interval): Date {
  const end = new Date(start);
  if (interval === 'yearly') end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Paystack ──────────────────────────────────────────────────────────

export interface PaystackConfig {
  secretKey: string;
  baseUrl?: string;
  /** Paystack plan codes (PLN_…) for each paid plan and interval, created in the dashboard. */
  planCodes: Partial<Record<`${PaidPlan}_${Interval}`, string>>;
}

type Json = Record<string, unknown>;

export class PaystackProvider implements PaymentProvider {
  readonly id = 'paystack' as const;
  readonly testMode: boolean;
  private readonly base: string;

  constructor(private readonly config: PaystackConfig) {
    this.testMode = config.secretKey.startsWith('sk_test_');
    this.base = (config.baseUrl ?? 'https://api.paystack.co').replace(/\/+$/, '');
  }

  private async call(method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          'content-type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new PaymentError('provider_unreachable');
    }
    if (!res.ok) throw new PaymentError('provider_refused', res.status);
    const json = (await res.json()) as { status?: boolean; data?: Json };
    if (!json.status) throw new PaymentError('provider_refused', res.status);
    return json.data ?? {};
  }

  private planFor(code: string): { plan: PaidPlan; interval: Interval } | null {
    for (const [key, value] of Object.entries(this.config.planCodes)) {
      if (value === code) {
        const [plan, interval] = key.split('_') as [PaidPlan, Interval];
        return { plan, interval };
      }
    }
    return null;
  }

  async checkout(input: Parameters<PaymentProvider['checkout']>[0]) {
    const plan = this.config.planCodes[`${input.plan}_${input.interval}`];
    if (!plan) throw new PaymentError('plan_not_configured');
    const reference = `sotto_${randomBytes(12).toString('hex')}`;
    const data = await this.call('POST', '/transaction/initialize', {
      email: input.email,
      // Paystack takes the amount from the plan; a placeholder keeps the request valid.
      amount: 100,
      plan,
      reference,
      callback_url: input.callbackUrl,
      metadata: { workspaceId: input.workspaceId, plan: input.plan, interval: input.interval },
    });
    if (typeof data.authorization_url !== 'string') throw new PaymentError('provider_refused');
    return { url: data.authorization_url, reference };
  }

  async confirm(reference: string): Promise<Activation | null> {
    const data = await this.call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
    if (data.status !== 'success') return null;
    const meta = (data.metadata ?? {}) as Json;
    const customer = (data.customer ?? {}) as Json;
    const planObject = (data.plan_object ?? {}) as Json;
    const planCode =
      (typeof data.plan === 'string' ? data.plan : null) ??
      (typeof planObject.plan_code === 'string' ? planObject.plan_code : null);
    const known = planCode ? this.planFor(planCode) : null;
    if (typeof meta.workspaceId !== 'string' || !known) return null;
    // The subscription Paystack made for this customer and plan, if it exists yet.
    let externalId: string | null = null;
    let periodEnd: Date | null = null;
    if (customer.id !== undefined && planObject.id !== undefined) {
      const list = await this.call(
        'GET',
        `/subscription?customer=${encodeURIComponent(String(customer.id))}&plan=${encodeURIComponent(String(planObject.id))}`,
      ).catch(() => null);
      const subs = (Array.isArray(list) ? list : []) as Json[];
      const latest = subs
        .filter((s) => s.status === 'active' && typeof s.subscription_code === 'string')
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
      if (latest) {
        externalId = latest.subscription_code as string;
        periodEnd = dateOrNull(latest.next_payment_date);
      }
    }
    return {
      workspaceId: meta.workspaceId,
      ...known,
      customerRef: typeof customer.customer_code === 'string' ? customer.customer_code : null,
      externalId,
      periodEnd: periodEnd ?? periodEndFrom(new Date(), known.interval),
    };
  }

  async manageUrl(externalId: string): Promise<string | null> {
    const data = await this.call(
      'GET',
      `/subscription/${encodeURIComponent(externalId)}/manage/link`,
    );
    return typeof data.link === 'string' ? data.link : null;
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const signature = headers['x-paystack-signature'];
    if (typeof signature !== 'string') return null;
    const expected = createHmac('sha512', this.config.secretKey).update(rawBody).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let payload: { event?: string; data?: Json };
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as typeof payload;
    } catch {
      return null;
    }
    // Paystack sends no event id; the body's hash identifies a delivery and its retries.
    const id = `paystack:${createHash('sha256').update(rawBody).digest('hex')}`;
    const data = payload.data ?? {};
    const sub = (data.subscription ?? {}) as Json;
    const code = (v: unknown) => (typeof v === 'string' ? v : null);
    switch (payload.event) {
      case 'charge.success': {
        const reference = code(data.reference);
        if (!reference) return { id, type: 'ignored' as const, event: payload.event };
        return {
          id,
          type: 'charge.success' as const,
          reference,
          subscriptionCode: code(sub.subscription_code),
        };
      }
      case 'subscription.create': {
        const plan = (data.plan ?? {}) as Json;
        const customer = (data.customer ?? {}) as Json;
        const subscriptionCode = code(data.subscription_code);
        const planCode = code(plan.plan_code);
        const customerRef = code(customer.customer_code);
        if (!subscriptionCode || !planCode || !customerRef) break;
        return {
          id,
          type: 'subscription.create' as const,
          subscriptionCode,
          customerRef,
          planCode,
          periodEnd: dateOrNull(data.next_payment_date),
        };
      }
      case 'invoice.update':
      case 'invoice.create': {
        const subscriptionCode = code(sub.subscription_code);
        if (!subscriptionCode || data.paid !== true) break;
        return {
          id,
          type: 'invoice.paid' as const,
          subscriptionCode,
          periodEnd: dateOrNull(sub.next_payment_date ?? data.next_payment_date),
        };
      }
      case 'invoice.payment_failed': {
        const subscriptionCode = code(sub.subscription_code);
        if (!subscriptionCode) break;
        return { id, type: 'invoice.payment_failed' as const, subscriptionCode };
      }
      case 'subscription.not_renew':
      case 'subscription.disable': {
        const subscriptionCode = code(data.subscription_code);
        if (!subscriptionCode) break;
        return {
          id,
          type: 'subscription.cancelled' as const,
          subscriptionCode,
          // not_renew: it runs to the end of the period; disable: it has ended.
          ended: payload.event === 'subscription.disable',
        };
      }
      default:
        break;
    }
    return { id, type: 'ignored' as const, event: String(payload.event ?? 'unknown') };
  }

  /** The plan a Paystack plan code stands for (for subscription.create). */
  planOf(code: string) {
    return this.planFor(code);
  }
}

// ── The labelled stand-in ─────────────────────────────────────────────

/**
 * Used when no payment provider is configured (the demo, development, tests): "checkout" goes
 * straight back to the app and the plan changes at once, with nothing charged. Every screen
 * that shows it says "Test checkout · no payment provider".
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly id = 'test' as const;
  readonly testMode = true;

  checkout(input: Parameters<PaymentProvider['checkout']>[0]) {
    const reference = [
      'test',
      input.workspaceId,
      input.plan,
      input.interval,
      randomBytes(4).toString('hex'),
    ].join('.');
    const url = new URL(input.callbackUrl);
    url.searchParams.set('reference', reference);
    return Promise.resolve({ url: url.toString(), reference });
  }

  confirm(reference: string): Promise<Activation | null> {
    const [prefix, workspaceId, plan, interval] = reference.split('.');
    if (
      prefix !== 'test' ||
      !workspaceId ||
      (plan !== 'PRO' && plan !== 'BUSINESS') ||
      (interval !== 'monthly' && interval !== 'yearly')
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve({
      workspaceId,
      plan,
      interval,
      customerRef: null,
      externalId: `test_${reference}`,
      periodEnd: periodEndFrom(new Date(), interval),
    });
  }

  manageUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }

  parseWebhook(): BillingWebhook | null {
    return null;
  }
}

export interface PaymentSettings {
  PAYSTACK_SECRET_KEY?: string | undefined;
  PAYSTACK_BASE_URL?: string | undefined;
  PAYSTACK_PLAN_PRO_MONTHLY?: string | undefined;
  PAYSTACK_PLAN_PRO_YEARLY?: string | undefined;
  PAYSTACK_PLAN_BUSINESS_MONTHLY?: string | undefined;
  PAYSTACK_PLAN_BUSINESS_YEARLY?: string | undefined;
  BILLING_ALLOW_LIVE: boolean;
}

/** Paystack when a key is set (test keys only, unless BILLING_ALLOW_LIVE), else the stand-in. */
export function paymentProviderFrom(settings: PaymentSettings): PaymentProvider {
  const key = settings.PAYSTACK_SECRET_KEY;
  if (!key) return new TestPaymentProvider();
  if (!key.startsWith('sk_test_') && !settings.BILLING_ALLOW_LIVE) {
    throw new Error(
      'PAYSTACK_SECRET_KEY is a live key. Phase 6 bills in test mode; set BILLING_ALLOW_LIVE=true deliberately to take real payments.',
    );
  }
  return new PaystackProvider({
    secretKey: key,
    ...(settings.PAYSTACK_BASE_URL ? { baseUrl: settings.PAYSTACK_BASE_URL } : {}),
    planCodes: {
      PRO_monthly: settings.PAYSTACK_PLAN_PRO_MONTHLY,
      PRO_yearly: settings.PAYSTACK_PLAN_PRO_YEARLY,
      BUSINESS_monthly: settings.PAYSTACK_PLAN_BUSINESS_MONTHLY,
      BUSINESS_yearly: settings.PAYSTACK_PLAN_BUSINESS_YEARLY,
    },
  });
}
