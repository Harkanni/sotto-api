import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CURRENCY, PRICES_ARE_PLACEHOLDERS, type PlanConfig } from '@sotto/contracts';
import { z } from 'zod';
import { RequireRole } from '../auth/auth.guard.js';
import { ApiErrors } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { UsageService, periodOf } from './usage.service.js';

export const PlanIdSchema = z
  .enum(['FREE', 'PRO', 'BUSINESS', 'ENTERPRISE'])
  .meta({ id: 'PlanId' });

const Limit = z.number().nullable();

export const PlanSchema = z
  .object({
    id: PlanIdSchema,
    name: z.string(),
    summary: z.string(),
    /** In minor units of `currency` (kobo); null = talk to sales. */
    price: z.object({ monthly: z.number(), yearly: z.number() }).nullable(),
    currency: z.string(),
    /** Prices are placeholders until the owner sets them; the UI says so. */
    placeholderPrices: z.boolean(),
    modes: z.array(z.enum(['PRIVATE', 'BYOK', 'MANAGED'])),
    limits: z.object({
      privateTokens: Limit,
      managedTokens: Limit,
      transcriptionMinutes: Limit,
      storageBytes: Limit,
    }),
    features: z.array(z.string()),
    selfServe: z.boolean(),
  })
  .meta({ id: 'Plan' });

export function planOut(plan: PlanConfig): z.infer<typeof PlanSchema> {
  return { ...plan, currency: CURRENCY, placeholderPrices: PRICES_ARE_PLACEHOLDERS };
}

const Meter = z.object({
  id: z.enum(['privateTokens', 'managedTokens', 'transcriptionMinutes', 'storageBytes']),
  used: z.number(),
  /** null = unlimited; 0 = not in this plan. */
  limit: Limit,
});

export const UsageReportSchema = z
  .object({
    range: z.enum(['7d', '30d', '90d']),
    plan: PlanSchema,
    /** The month the limits count over (UTC). */
    period: z.object({ start: z.string(), end: z.string() }),
    meters: z.array(Meter),
    /** Tokens on the workspace's own keys this month: shown, never limited. */
    byokTokens: z.number(),
    daily: z.array(
      z.object({
        date: z.string(),
        privateTokens: z.number(),
        managedTokens: z.number(),
        byokTokens: z.number(),
        transcriptionMinutes: z.number(),
      }),
    ),
  })
  .meta({ id: 'UsageReport' });

const UsageQuery = z.object({ range: z.enum(['7d', '30d', '90d']).default('30d') });
const DAYS = { '7d': 7, '30d': 30, '90d': 90 } as const;

@ApiTags('billing')
@ApiErrors()
@Controller()
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @Get('usage')
  @RequireRole('owner')
  @ApiOperation({ summary: 'This month’s usage against the plan, and daily usage for a chart.' })
  @ApiOkResponse({ standardSchema: UsageReportSchema })
  async report(
    @Ctx() auth: RequestAuth,
    @Query({ schema: UsageQuery }) query: z.infer<typeof UsageQuery>,
  ): Promise<z.infer<typeof UsageReportSchema>> {
    const workspaceId = workspaceOf(auth).id;
    const [{ plan }, used, daily] = await Promise.all([
      this.usage.plan(workspaceId),
      this.usage.used(workspaceId),
      this.usage.daily(workspaceId, DAYS[query.range]),
    ]);
    const period = periodOf();
    return {
      range: query.range,
      plan: planOut(plan),
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      meters: (
        ['privateTokens', 'managedTokens', 'transcriptionMinutes', 'storageBytes'] as const
      ).map((id) => ({ id, used: used[id], limit: plan.limits[id] })),
      byokTokens: used.byokTokens,
      daily,
    };
  }
}
