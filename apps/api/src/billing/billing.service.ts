import { Inject, Injectable, Logger } from '@nestjs/common';
import { planById } from '@sotto/contracts';
import { type Subscription, forWorkspace } from '@sotto/db';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/errors.js';
import type { RequestAuth } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import {
  type Activation,
  type BillingWebhook,
  type Interval,
  type PaidPlan,
  type PaymentProvider,
  PaymentError,
  PaystackProvider,
  paymentProviderFrom,
} from './payments.js';
import { UsageService } from './usage.service.js';

const PAYMENT_MESSAGE: Record<PaymentError['code'], string> = {
  provider_unreachable: 'Couldn’t reach the payment provider. Nothing was charged. Try again.',
  provider_refused: 'The payment provider refused the request. Nothing was charged. Try again.',
  plan_not_configured:
    'This plan isn’t set up with the payment provider yet. Ask whoever runs Sotto to add it.',
};

function paymentError(error: unknown): never {
  if (error instanceof PaymentError) {
    throw new ApiException(502, `PAYMENT_${error.code.toUpperCase()}`, PAYMENT_MESSAGE[error.code]);
  }
  throw error;
}

/**
 * Plans and payments for a workspace (BRIEF §4 Billing, ADR 0004). The owner starts checkout
 * on the provider's page; on return the api verifies the payment with the provider before the
 * plan changes; signed webhooks keep the subscription current (renewals, failures, cancels).
 */
@Injectable()
export class BillingService {
  private readonly log = new Logger('billing');
  provider: PaymentProvider;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(UsageService) private readonly usage: UsageService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
  ) {
    this.provider = paymentProviderFrom(config);
  }

  /** Where the provider sends the owner back to (the app's Usage and billing screen). */
  callbackUrl(): string {
    return new URL('/profile/usage?checkout=done', this.config.APP_URL).toString();
  }

  async checkout(
    auth: RequestAuth,
    workspaceId: string,
    plan: PaidPlan,
    interval: Interval,
  ): Promise<{ url: string }> {
    if (!planById(plan).selfServe) {
      throw new ApiException(400, 'NOT_SELF_SERVE', 'Talk to us about this plan.');
    }
    const { subscription } = await this.usage.plan(workspaceId);
    if (subscription?.plan === plan && subscription.status === 'ACTIVE') {
      throw new ApiException(
        409,
        'ALREADY_ON_PLAN',
        `This workspace is already on ${planById(plan).name}.`,
      );
    }
    if (subscription && subscription.provider === 'paystack' && subscription.status === 'ACTIVE') {
      // Paystack changes plans by cancelling one subscription and starting another, which the
      // owner does on its page; starting a second one here would charge twice.
      throw new ApiException(
        409,
        'MANAGE_FIRST',
        'Cancel the current plan in Manage subscription first, then choose the new one.',
      );
    }
    try {
      const { url } = await this.provider.checkout({
        workspaceId,
        plan,
        interval,
        email: auth.user.email,
        callbackUrl: this.callbackUrl(),
      });
      return { url };
    } catch (error) {
      return paymentError(error);
    }
  }

  /**
   * The owner is back from checkout: verify the payment with the provider, and only then
   * change the plan. A reference for another workspace changes nothing.
   */
  async confirm(auth: RequestAuth, workspaceId: string, reference: string): Promise<Subscription> {
    let activation: Activation | null;
    try {
      activation = await this.provider.confirm(reference);
    } catch (error) {
      return paymentError(error);
    }
    if (!activation || activation.workspaceId !== workspaceId) {
      throw new ApiException(
        409,
        'PAYMENT_NOT_FOUND',
        'That payment didn’t go through, so the plan hasn’t changed. Nothing was charged twice.',
      );
    }
    const saved = await this.activate(activation);
    await this.audit.record(workspaceId, auth, {
      action: 'billing.plan_changed',
      target: { type: 'subscription', id: workspaceId },
      meta: { to: planById(activation.plan).name, test: this.provider.testMode },
    });
    return saved;
  }

  private async activate(a: Activation): Promise<Subscription> {
    const data = {
      plan: a.plan,
      status: 'ACTIVE' as const,
      provider: this.provider.id,
      customerRef: a.customerRef,
      externalId: a.externalId,
      currentPeriodEnd: a.periodEnd,
    };
    return forWorkspace(this.prisma.client, a.workspaceId).subscription.upsert({
      where: { workspaceId: a.workspaceId },
      create: { workspaceId: a.workspaceId, ...data },
      update: data,
    });
  }

  /** A link to the provider's page for the card and cancelling, or a test-mode downgrade. */
  async portal(auth: RequestAuth, workspaceId: string): Promise<{ url: string | null }> {
    const { subscription } = await this.usage.plan(workspaceId);
    if (!subscription || subscription.status === 'CANCELLED') {
      throw new ApiException(409, 'NO_SUBSCRIPTION', 'This workspace is on the Free plan.');
    }
    if (subscription.provider === 'test') {
      // The stand-in has no page: "managing" a test plan ends it at once.
      await forWorkspace(this.prisma.client, workspaceId).subscription.delete({
        where: { workspaceId },
      });
      await this.audit.record(workspaceId, auth, {
        action: 'billing.cancelled',
        target: { type: 'subscription', id: workspaceId },
        meta: { plan: planById(subscription.plan).name },
      });
      return { url: null };
    }
    if (!subscription.externalId) {
      throw new ApiException(
        409,
        'SUBSCRIPTION_PENDING',
        'The payment provider is still setting up this subscription. Try again in a minute.',
      );
    }
    try {
      return { url: await this.provider.manageUrl(subscription.externalId) };
    } catch (error) {
      return paymentError(error);
    }
  }

  /**
   * A signed webhook. Returns false when the signature doesn't match (the caller answers 401).
   * Each delivery is handled once, however often the provider retries it.
   */
  async webhook(
    raw: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<boolean> {
    const event = this.provider.parseWebhook(raw, headers);
    if (!event) return false;
    if (event.type === 'ignored') return true;
    try {
      await this.prisma.client.billingEvent.create({
        data: { id: event.id, provider: this.provider.id, type: event.type },
      });
    } catch {
      return true; // already handled
    }
    await this.handle(event).catch((error: unknown) => {
      this.log.error(
        `webhook ${event.type} failed (${error instanceof Error ? error.name : 'error'})`,
      );
      // Let the provider retry: forget this delivery so the retry isn't skipped.
      return this.prisma.client.billingEvent.delete({ where: { id: event.id } }).then(() => {
        throw error;
      });
    });
    return true;
  }

  private bySubscription(code: string) {
    // A webhook names a subscription, not a workspace; the subscription code is unique.
    return this.prisma.client.subscription.findFirst({
      where: { provider: this.provider.id, externalId: code },
    });
  }

  private async handle(event: Exclude<BillingWebhook, { type: 'ignored' }>): Promise<void> {
    const db = this.prisma.client;
    switch (event.type) {
      case 'charge.success': {
        // A first payment whose owner closed the tab before coming back: link it now.
        const activation = await this.provider.confirm(event.reference).catch(() => null);
        if (!activation) return;
        const current = await db.subscription.findUnique({
          where: { workspaceId: activation.workspaceId },
        });
        const already = current?.status === 'ACTIVE' && current.plan === activation.plan;
        await this.activate({
          ...activation,
          externalId: activation.externalId ?? current?.externalId ?? event.subscriptionCode,
        });
        await db.billingEvent.update({
          where: { id: event.id },
          data: { forWorkspace: activation.workspaceId },
        });
        if (!already) {
          await this.audit.recordSystem(activation.workspaceId, {
            action: 'billing.plan_changed',
            target: { type: 'subscription', id: activation.workspaceId },
            meta: { to: planById(activation.plan).name, test: this.provider.testMode },
          });
        }
        return;
      }
      case 'subscription.create': {
        if (!(this.provider instanceof PaystackProvider)) return;
        const plan = this.provider.planOf(event.planCode);
        if (!plan) return;
        // The checkout that made it was already verified and linked by customer and plan.
        const pending = await db.subscription.findFirst({
          where: {
            provider: 'paystack',
            customerRef: event.customerRef,
            plan: plan.plan,
            externalId: null,
          },
          orderBy: { updatedAt: 'desc' },
        });
        if (!pending) return;
        await db.subscription.update({
          where: { workspaceId: pending.workspaceId },
          data: {
            externalId: event.subscriptionCode,
            ...(event.periodEnd ? { currentPeriodEnd: event.periodEnd } : {}),
          },
        });
        return;
      }
      case 'invoice.paid': {
        const sub = await this.bySubscription(event.subscriptionCode);
        if (!sub) return;
        await db.subscription.update({
          where: { workspaceId: sub.workspaceId },
          data: {
            status: 'ACTIVE',
            ...(event.periodEnd ? { currentPeriodEnd: event.periodEnd } : {}),
          },
        });
        return;
      }
      case 'invoice.payment_failed': {
        const sub = await this.bySubscription(event.subscriptionCode);
        if (!sub) return;
        await db.subscription.update({
          where: { workspaceId: sub.workspaceId },
          data: { status: 'PAST_DUE' },
        });
        await this.audit.recordSystem(sub.workspaceId, {
          action: 'billing.payment_failed',
          target: { type: 'subscription', id: sub.workspaceId },
          meta: { plan: planById(sub.plan).name },
        });
        return;
      }
      case 'subscription.cancelled': {
        const sub = await this.bySubscription(event.subscriptionCode);
        if (!sub || sub.status === 'CANCELLED') return;
        await db.subscription.update({
          where: { workspaceId: sub.workspaceId },
          data: {
            status: 'CANCELLED',
            // Disabled now: it ends now. Not renewing: it runs to the end of what was paid.
            ...(event.ended ? { currentPeriodEnd: new Date() } : {}),
          },
        });
        await this.audit.recordSystem(sub.workspaceId, {
          action: 'billing.cancelled',
          target: { type: 'subscription', id: sub.workspaceId },
          meta: { plan: planById(sub.plan).name },
        });
        return;
      }
    }
  }
}
