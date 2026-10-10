import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PLANS } from '@sotto/contracts';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { Public, RequireRole } from '../auth/auth.guard.js';
import { ApiErrors } from '../common/errors.js';
import { Ctx, type ApiRequest, type RequestAuth, workspaceOf } from '../common/request.js';
import { BillingService } from './billing.service.js';
import { PlanSchema, planOut } from './usage.controller.js';
import { UsageService } from './usage.service.js';

export const BillingSchema = z
  .object({
    /** The plan in effect now (Free with no subscription, or after a paid period ends). */
    plan: PlanSchema,
    subscription: z
      .object({
        status: z.enum(['ACTIVE', 'PAST_DUE', 'CANCELLED']),
        provider: z.string(),
        /** When the paid period ends (renews, or for a cancelled plan, stops). */
        currentPeriodEnd: z.string().nullable(),
      })
      .nullable(),
    plans: z.array(PlanSchema),
    provider: z.object({
      id: z.enum(['paystack', 'test']),
      /** No real money moves; the UI says so. */
      testMode: z.boolean(),
      label: z.string(),
    }),
  })
  .meta({ id: 'Billing' });

export const CheckoutBody = z
  .object({
    plan: z.enum(['PRO', 'BUSINESS']),
    interval: z.enum(['monthly', 'yearly']).default('monthly'),
  })
  .meta({ id: 'CheckoutBody' });

export const ConfirmBody = z
  .object({ reference: z.string().trim().min(4).max(200) })
  .meta({ id: 'ConfirmCheckoutBody' });

const UrlSchema = z.object({ url: z.string().nullable() }).meta({ id: 'BillingUrl' });

/**
 * Usage and billing (PLAN → API): the owner's plan, checkout on the provider's page, the
 * provider's page for the card and cancelling, and the provider's signed webhook.
 */
@ApiTags('billing')
@ApiErrors()
@Controller()
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(UsageService) private readonly usage: UsageService,
  ) {}

  private async summary(workspaceId: string): Promise<z.infer<typeof BillingSchema>> {
    const { plan, subscription } = await this.usage.plan(workspaceId);
    const provider = this.billing.provider;
    return {
      plan: planOut(plan),
      subscription: subscription
        ? {
            status: subscription.status,
            provider: subscription.provider,
            currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
          }
        : null,
      plans: PLANS.map(planOut),
      provider: {
        id: provider.id,
        testMode: provider.testMode,
        label:
          provider.id === 'test'
            ? 'Test checkout · no payment provider'
            : provider.testMode
              ? 'Paystack · test mode'
              : 'Paystack',
      },
    };
  }

  @Get('billing')
  @RequireRole('owner')
  @ApiOperation({ summary: 'The plan, the subscription and the plans to choose from.' })
  @ApiOkResponse({ standardSchema: BillingSchema })
  async get(@Ctx() auth: RequestAuth): Promise<z.infer<typeof BillingSchema>> {
    return this.summary(workspaceOf(auth).id);
  }

  @Post('billing/checkout')
  @RequireRole('owner')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start checkout for a plan; returns the payment page to open.' })
  @ApiOkResponse({ standardSchema: UrlSchema })
  async checkout(
    @Ctx() auth: RequestAuth,
    @Body({ schema: CheckoutBody }) body: z.infer<typeof CheckoutBody>,
  ): Promise<z.infer<typeof UrlSchema>> {
    return this.billing.checkout(auth, workspaceOf(auth).id, body.plan, body.interval);
  }

  @Post('billing/confirm')
  @RequireRole('owner')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Back from checkout: the api verifies the payment with the provider, then the plan changes.',
  })
  @ApiOkResponse({ standardSchema: BillingSchema })
  async confirm(
    @Ctx() auth: RequestAuth,
    @Body({ schema: ConfirmBody }) body: z.infer<typeof ConfirmBody>,
  ): Promise<z.infer<typeof BillingSchema>> {
    const workspaceId = workspaceOf(auth).id;
    await this.billing.confirm(auth, workspaceId, body.reference);
    return this.summary(workspaceId);
  }

  @Post('billing/portal')
  @RequireRole('owner')
  @HttpCode(200)
  @ApiOperation({
    summary: 'The provider’s page to update the card or cancel (test mode: ends the plan at once).',
  })
  @ApiOkResponse({ standardSchema: UrlSchema })
  async portal(@Ctx() auth: RequestAuth): Promise<z.infer<typeof UrlSchema>> {
    return this.billing.portal(auth, workspaceOf(auth).id);
  }

  /** Paystack's webhook: no session; the signature over the exact body is the proof. */
  @Post('webhooks/paystack')
  @Public()
  @ApiExcludeEndpoint()
  async paystack(@Req() req: ApiRequest & { rawBody?: Buffer }, @Res() res: ServerResponse) {
    const ok = req.rawBody ? await this.billing.webhook(req.rawBody, req.headers) : false;
    res.statusCode = ok ? 200 : 401;
    res.end();
  }
}
