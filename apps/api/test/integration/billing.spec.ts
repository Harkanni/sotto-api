import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillingService } from '../../src/billing/billing.service.js';
import { TestPaymentProvider } from '../../src/billing/payments.js';
import { APP_URL, withDatabase } from './harness.js';
import { Kestrel } from './kestrel.js';

const SECRET = 'sk_test_billing_spec_000000000000';

/**
 * A stand-in for Paystack's API: initialize, verify, the subscription list and the manage link,
 * as Paystack documents them. Tests choose whether a reference was paid.
 */
class StandInPaystack {
  url = '';
  private server: Server | null = null;
  readonly paid = new Map<string, { workspaceId: string; plan: string; interval: string }>();
  readonly initialized: Record<string, unknown>[] = [];
  subscriptions: Record<string, unknown>[] = [];

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const ok = (data: unknown) => {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ status: true, message: 'ok', data }));
        };
        if (req.headers.authorization !== `Bearer ${SECRET}`) {
          res.writeHead(401).end(JSON.stringify({ status: false }));
          return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
          const body = JSON.parse(raw) as Record<string, unknown>;
          this.initialized.push(body);
          return ok({
            authorization_url: `https://checkout.paystack.test/${String(body.reference)}`,
            reference: body.reference,
          });
        }
        const verify = url.pathname.match(/^\/transaction\/verify\/(.+)$/);
        if (verify) {
          const reference = decodeURIComponent(verify[1]!);
          const paid = this.paid.get(reference);
          if (!paid) return ok({ status: 'abandoned', reference });
          return ok({
            status: 'success',
            reference,
            metadata: paid,
            customer: { id: 77, customer_code: 'CUS_ada' },
            plan: paid.plan === 'PRO' ? 'PLN_pro_m' : 'PLN_bus_m',
            plan_object: { id: 5, plan_code: paid.plan === 'PRO' ? 'PLN_pro_m' : 'PLN_bus_m' },
          });
        }
        if (url.pathname === '/subscription') return ok(this.subscriptions);
        const manage = url.pathname.match(/^\/subscription\/(.+)\/manage\/link$/);
        if (manage) return ok({ link: `https://paystack.test/manage/${manage[1]}` });
        res.writeHead(404).end(JSON.stringify({ status: false }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  stop() {
    return new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

function signed(body: object) {
  const raw = JSON.stringify(body);
  return { raw, signature: createHmac('sha512', SECRET).update(raw).digest('hex') };
}

describe.skipIf(withDatabase)('billing with Paystack (test mode)', () => {
  const k = new Kestrel('billing.example');
  const paystack = new StandInPaystack();
  const sub = async () => k.db.subscription.findUnique({ where: { workspaceId: k.workspaceId } });
  const hook = (body: object, signature?: string) => {
    const s = signed(body);
    return request(k.t.app.getHttpServer())
      .post('/api/v1/webhooks/paystack')
      .set('content-type', 'application/json')
      .set('x-paystack-signature', signature ?? s.signature)
      .send(s.raw);
  };

  beforeAll(async () => {
    await paystack.start();
    Object.assign(process.env, {
      PAYSTACK_SECRET_KEY: SECRET,
      PAYSTACK_BASE_URL: paystack.url,
      PAYSTACK_PLAN_PRO_MONTHLY: 'PLN_pro_m',
      PAYSTACK_PLAN_BUSINESS_MONTHLY: 'PLN_bus_m',
    });
    await k.start();
  });

  afterAll(async () => {
    await k.stop();
    await paystack.stop();
    for (const name of [
      'PAYSTACK_SECRET_KEY',
      'PAYSTACK_BASE_URL',
      'PAYSTACK_PLAN_PRO_MONTHLY',
      'PAYSTACK_PLAN_BUSINESS_MONTHLY',
    ]) {
      delete process.env[name];
    }
  });

  it('shows the owner the plan and the plans, in test mode; nobody else', async () => {
    await k.people.tunde.get('/api/v1/billing').expect(403);
    await k.people.tunde.post('/api/v1/billing/checkout', { plan: 'PRO' }).expect(403);
    const res = await k.people.ada.get('/api/v1/billing').expect(200);
    expect(res.body).toMatchObject({
      plan: { id: 'FREE' },
      subscription: null,
      provider: { id: 'paystack', testMode: true, label: 'Paystack · test mode' },
    });
    expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual([
      'FREE',
      'PRO',
      'BUSINESS',
      'ENTERPRISE',
    ]);
  });

  it('starts checkout on Paystack with the plan and the workspace', async () => {
    const res = await k.people.ada
      .post('/api/v1/billing/checkout', { plan: 'PRO', interval: 'monthly' })
      .expect(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.paystack\.test\/sotto_/);
    expect(paystack.initialized.at(-1)).toMatchObject({
      email: 'ada@billing.example',
      plan: 'PLN_pro_m',
      callback_url: `${APP_URL}/profile/usage?checkout=done`,
      metadata: { workspaceId: k.workspaceId, plan: 'PRO', interval: 'monthly' },
    });
    const yearly = await k.people.ada
      .post('/api/v1/billing/checkout', { plan: 'PRO', interval: 'yearly' })
      .expect(502);
    expect(yearly.body.error.code).toBe('PAYMENT_PLAN_NOT_CONFIGURED');
  });

  it('changes nothing until Paystack says the payment went through', async () => {
    const reference = String(paystack.initialized.at(-2)?.reference);
    const res = await k.people.ada.post('/api/v1/billing/confirm', { reference }).expect(409);
    expect(res.body.error.code).toBe('PAYMENT_NOT_FOUND');
    expect(await sub()).toBeNull();
  });

  it("won't take another workspace's payment", async () => {
    paystack.paid.set('sotto_someone_else', {
      workspaceId: 'other',
      plan: 'PRO',
      interval: 'monthly',
    });
    await k.people.ada
      .post('/api/v1/billing/confirm', { reference: 'sotto_someone_else' })
      .expect(409);
    expect(await sub()).toBeNull();
  });

  it('upgrades once the payment is verified', async () => {
    const reference = String(paystack.initialized[0]?.reference);
    paystack.paid.set(reference, { workspaceId: k.workspaceId, plan: 'PRO', interval: 'monthly' });
    const res = await k.people.ada.post('/api/v1/billing/confirm', { reference }).expect(200);
    expect(res.body).toMatchObject({ plan: { id: 'PRO' }, subscription: { status: 'ACTIVE' } });
    expect(await sub()).toMatchObject({
      plan: 'PRO',
      provider: 'paystack',
      customerRef: 'CUS_ada',
      externalId: null,
    });
    const portal = await k.people.ada.post('/api/v1/billing/portal').expect(409);
    expect(portal.body.error.code).toBe('SUBSCRIPTION_PENDING');
    const audit = await k.db.auditLog.findFirstOrThrow({
      where: { action: 'billing.plan_changed' },
    });
    expect(audit.meta).toMatchObject({ to: 'Pro', test: true });
  });

  it('refuses webhooks without a valid signature', async () => {
    await hook({ event: 'subscription.disable', data: {} }, 'nope').expect(401);
    await hook({ event: 'subscription.disable', data: {} }, 'a'.repeat(128)).expect(401);
    await request(k.t.app.getHttpServer())
      .post('/api/v1/webhooks/paystack')
      .set('content-type', 'application/json')
      .send('{}')
      .expect(401);
  });

  it('links the subscription Paystack creates, then opens its manage page', async () => {
    await hook({
      event: 'subscription.create',
      data: {
        subscription_code: 'SUB_ada',
        email_token: 'tok',
        status: 'active',
        next_payment_date: '2026-11-10T00:00:00.000Z',
        plan: { plan_code: 'PLN_pro_m' },
        customer: { customer_code: 'CUS_ada' },
      },
    }).expect(200);
    expect(await sub()).toMatchObject({
      externalId: 'SUB_ada',
      currentPeriodEnd: new Date('2026-11-10T00:00:00.000Z'),
    });
    const res = await k.people.ada.post('/api/v1/billing/portal').expect(200);
    expect(res.body.url).toBe('https://paystack.test/manage/SUB_ada');
  });

  it('marks a failed renewal past due, once however often Paystack retries', async () => {
    const body = {
      event: 'invoice.payment_failed',
      data: { subscription: { subscription_code: 'SUB_ada' } },
    };
    await hook(body).expect(200);
    await hook(body).expect(200);
    expect(await sub()).toMatchObject({ status: 'PAST_DUE', plan: 'PRO' });
    expect(await k.db.auditLog.count({ where: { action: 'billing.payment_failed' } })).toBe(1);
    // Past due keeps the plan working until the period ends.
    expect((await k.people.ada.get('/api/v1/billing').expect(200)).body.plan.id).toBe('PRO');
  });

  it('renews on a paid invoice', async () => {
    await hook({
      event: 'invoice.update',
      data: {
        paid: true,
        subscription: {
          subscription_code: 'SUB_ada',
          next_payment_date: '2026-12-10T00:00:00.000Z',
        },
      },
    }).expect(200);
    expect(await sub()).toMatchObject({
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2026-12-10T00:00:00.000Z'),
    });
  });

  it('asks to cancel first rather than start a second subscription', async () => {
    const res = await k.people.ada
      .post('/api/v1/billing/checkout', { plan: 'BUSINESS' })
      .expect(409);
    expect(res.body.error.code).toBe('MANAGE_FIRST');
  });

  it('keeps a cancelled plan to the end of the period, then falls back to Free', async () => {
    await hook({ event: 'subscription.not_renew', data: { subscription_code: 'SUB_ada' } }).expect(
      200,
    );
    expect(await sub()).toMatchObject({ status: 'CANCELLED' });
    expect((await k.people.ada.get('/api/v1/billing').expect(200)).body.plan.id).toBe('PRO');
    await hook({ event: 'subscription.disable', data: { subscription_code: 'SUB_ada' } }).expect(
      200,
    );
    // Already cancelled: the second event changes nothing (the period end stands).
    await k.db.subscription.update({
      where: { workspaceId: k.workspaceId },
      data: { currentPeriodEnd: new Date(Date.now() - 1000) },
    });
    expect((await k.people.ada.get('/api/v1/billing').expect(200)).body.plan.id).toBe('FREE');
  });

  it('links a payment whose owner never came back, from charge.success', async () => {
    await k.db.subscription.delete({ where: { workspaceId: k.workspaceId } });
    paystack.paid.set('sotto_closed_tab', {
      workspaceId: k.workspaceId,
      plan: 'BUSINESS',
      interval: 'monthly',
    });
    await hook({ event: 'charge.success', data: { reference: 'sotto_closed_tab' } }).expect(200);
    expect(await sub()).toMatchObject({ plan: 'BUSINESS', status: 'ACTIVE' });
    // Unknown events are acknowledged and ignored.
    await hook({ event: 'transfer.success', data: {} }).expect(200);
  });

  it('uses the labelled stand-in when no provider is configured', async () => {
    const billing = k.t.app.get(BillingService);
    const real = billing.provider;
    billing.provider = new TestPaymentProvider();
    try {
      await k.db.subscription.delete({ where: { workspaceId: k.workspaceId } });
      const summary = await k.people.ada.get('/api/v1/billing').expect(200);
      expect(summary.body.provider).toEqual({
        id: 'test',
        testMode: true,
        label: 'Test checkout · no payment provider',
      });
      const { body } = await k.people.ada
        .post('/api/v1/billing/checkout', { plan: 'PRO' })
        .expect(200);
      const reference = new URL(body.url as string).searchParams.get('reference')!;
      expect(body.url).toContain(`${APP_URL}/profile/usage?checkout=done`);
      // Kofi can't confirm (not the owner); a reference for another workspace changes nothing.
      await k.people.kofi.post('/api/v1/billing/confirm', { reference }).expect(403);
      await k.people.ada
        .post('/api/v1/billing/confirm', { reference: reference.replace(k.workspaceId, 'other') })
        .expect(409);
      const done = await k.people.ada.post('/api/v1/billing/confirm', { reference }).expect(200);
      expect(done.body.plan.id).toBe('PRO');
      // "Manage" on a test plan ends it at once.
      expect((await k.people.ada.post('/api/v1/billing/portal').expect(200)).body.url).toBeNull();
      expect(await sub()).toBeNull();
    } finally {
      billing.provider = real;
    }
  });
});
