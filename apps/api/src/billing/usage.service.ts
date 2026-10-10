import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AiMode,
  type PlanConfig,
  type PlanId,
  cheapestPlanWith,
  nextPlan,
  planById,
} from '@sotto/contracts';
import { type AiRoute, type Subscription, forWorkspace } from '@sotto/db';
import { ApiException } from '../common/errors.js';
import { PrismaService } from '../core.module.js';

const DAY = 86_400_000;

export interface PeriodUsage {
  privateTokens: number;
  managedTokens: number;
  /** Counted for the chart, never against a limit: the workspace pays its own provider. */
  byokTokens: number;
  transcriptionMinutes: number;
  storageBytes: number;
}

export interface DailyUsage {
  date: string;
  privateTokens: number;
  managedTokens: number;
  byokTokens: number;
  transcriptionMinutes: number;
}

/** The calendar month (UTC) quotas count over. */
export function periodOf(now = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** "1 November", for "it resets on …". */
function resetsOn(end: Date): string {
  return end.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round(bytes / 1024 ** 3)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * Metering and quotas (BRIEF §4 Billing). Usage is recorded as events (tokens by route,
 * transcription minutes) and summed per calendar month; storage is read live from the files,
 * so it can never drift. Quotas are checked before work starts, and the refusal says what to do
 * next in plain words. Nothing here ever holds content: only quantities.
 */
@Injectable()
export class UsageService {
  private readonly log = new Logger('usage');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The workspace's plan now: its subscription while it lasts, else Free. */
  async plan(
    workspaceId: string,
  ): Promise<{ plan: PlanConfig; subscription: Subscription | null }> {
    const subscription = await forWorkspace(
      this.prisma.client,
      workspaceId,
    ).subscription.findFirst();
    return { plan: planById(effectivePlan(subscription)), subscription };
  }

  async allowsMode(workspaceId: string, mode: AiMode): Promise<boolean> {
    return (await this.plan(workspaceId)).plan.modes.includes(mode);
  }

  /** Records tokens or minutes. A failure is logged, never thrown: the work already happened. */
  async record(
    workspaceId: string,
    events: {
      kind: 'AI_INPUT_TOKENS' | 'AI_OUTPUT_TOKENS' | 'TRANSCRIPTION_SECONDS';
      quantity: number;
      route?: AiRoute | null;
      model?: string | null;
      userId?: string | null;
      subjectId?: string | null;
    }[],
  ): Promise<void> {
    const rows = events
      .filter((e) => e.quantity > 0)
      .map((e) => ({
        workspaceId,
        kind: e.kind,
        quantity: BigInt(Math.round(e.quantity)),
        route: e.route ?? null,
        model: e.model ?? null,
        userId: e.userId ?? null,
        subjectId: e.subjectId ?? null,
      }));
    if (!rows.length) return;
    try {
      await forWorkspace(this.prisma.client, workspaceId).usageEvent.createMany({
        data: rows,
        skipDuplicates: true,
      });
    } catch (error) {
      this.log.error(`could not record usage (${(error as { code?: string }).code ?? 'error'})`);
    }
  }

  /** What this workspace has used in the current period. */
  async used(workspaceId: string, now = new Date()): Promise<PeriodUsage> {
    const { start } = periodOf(now);
    const rows = await this.prisma.client.$queryRawUnsafe<
      { kind: string; route: AiRoute | null; total: bigint }[]
    >(
      `SELECT kind::text AS kind, route, COALESCE(SUM(quantity), 0)::bigint AS total
         FROM usage_events
        WHERE workspace_id = $1 AND at >= $2 AND kind <> 'STORAGE_BYTES'
        GROUP BY kind, route`,
      workspaceId,
      start,
    );
    const tokens = (route: AiRoute) =>
      rows
        .filter((r) => r.route === route && r.kind.startsWith('AI_'))
        .reduce((sum, r) => sum + Number(r.total), 0);
    const seconds = rows
      .filter((r) => r.kind === 'TRANSCRIPTION_SECONDS')
      .reduce((sum, r) => sum + Number(r.total), 0);
    return {
      privateTokens: tokens('PRIVATE'),
      managedTokens: tokens('MANAGED'),
      byokTokens: tokens('BYOK'),
      transcriptionMinutes: Math.ceil(seconds / 60),
      storageBytes: await this.storageBytes(workspaceId),
    };
  }

  /** Every stored file, the trash included (it still takes space until it's purged). */
  async storageBytes(workspaceId: string): Promise<number> {
    const sum = await forWorkspace(this.prisma.client, workspaceId).file.aggregate({
      _sum: { sizeBytes: true },
    });
    return Number(sum._sum.sizeBytes ?? 0n);
  }

  /** Refuses a question when the route's monthly allowance is used up (BYOK never is). */
  async checkAsk(workspaceId: string, route: AiRoute): Promise<void> {
    if (route === 'BYOK') return;
    const { plan } = await this.plan(workspaceId);
    if (route === 'MANAGED' && !plan.modes.includes('MANAGED')) {
      const upgrade = cheapestPlanWith('MANAGED');
      throw new ApiException(
        402,
        'PLAN_REQUIRED',
        `Managed AI comes with the ${upgrade?.name ?? 'Pro'} plan. Upgrade to use it, or use your own API key.`,
      );
    }
    const limit = route === 'PRIVATE' ? plan.limits.privateTokens : plan.limits.managedTokens;
    if (limit === null) return;
    const used = await this.used(workspaceId);
    const spent = route === 'PRIVATE' ? used.privateTokens : used.managedTokens;
    if (spent < limit) return;
    const next = nextPlan(plan.id);
    const what = route === 'PRIVATE' ? 'private AI allowance' : 'Managed AI allowance';
    throw new ApiException(
      402,
      'QUOTA_EXCEEDED',
      `This workspace has used this month’s ${what} on the ${plan.name} plan. ` +
        `${next ? `Upgrade to ${next.name}, use` : 'Use'} your own API key, or wait until ${resetsOn(periodOf().end)}.`,
    );
  }

  /** Refuses an upload that the plan's storage or transcription allowance can't take. */
  async checkUpload(workspaceId: string, kind: 'DOCUMENT' | 'AUDIO' | 'NOTE', sizeBytes: number) {
    const { plan } = await this.plan(workspaceId);
    const next = nextPlan(plan.id);
    const { storageBytes, transcriptionMinutes } = plan.limits;
    if (storageBytes !== null) {
      const stored = await this.storageBytes(workspaceId);
      if (stored + sizeBytes > storageBytes) {
        throw new ApiException(
          402,
          'STORAGE_FULL',
          `This would take the workspace over its ${formatBytes(storageBytes)} on the ${plan.name} plan. ` +
            `Empty the trash, delete files${next ? `, or upgrade to ${next.name}` : ''}.`,
        );
      }
    }
    if (kind === 'AUDIO' && transcriptionMinutes !== null) {
      const used = await this.used(workspaceId);
      if (used.transcriptionMinutes >= transcriptionMinutes) {
        throw new ApiException(
          402,
          'QUOTA_EXCEEDED',
          `This workspace has transcribed its ${transcriptionMinutes} minutes for this month on the ${plan.name} plan. ` +
            `${next ? `Upgrade to ${next.name} for more, or wait` : 'Wait'} until ${resetsOn(periodOf().end)}. Documents still upload.`,
        );
      }
    }
  }

  /** Daily usage for the chart, oldest first, with every day present. */
  async daily(workspaceId: string, days: number, now = new Date()): Promise<DailyUsage[]> {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const from = new Date(today - (days - 1) * DAY);
    const rows = await this.prisma.client.$queryRawUnsafe<
      { day: Date; kind: string; route: AiRoute | null; total: bigint }[]
    >(
      `SELECT date_trunc('day', at AT TIME ZONE 'UTC') AS day, kind::text AS kind, route,
              SUM(quantity)::bigint AS total
         FROM usage_events
        WHERE workspace_id = $1 AND at >= $2 AND kind <> 'STORAGE_BYTES'
        GROUP BY 1, 2, 3`,
      workspaceId,
      from,
    );
    const out = new Map<string, DailyUsage>();
    for (let i = 0; i < days; i++) {
      const date = new Date(from.getTime() + i * DAY).toISOString().slice(0, 10);
      out.set(date, {
        date,
        privateTokens: 0,
        managedTokens: 0,
        byokTokens: 0,
        transcriptionMinutes: 0,
      });
    }
    for (const r of rows) {
      const day = out.get(new Date(r.day).toISOString().slice(0, 10));
      if (!day) continue;
      const n = Number(r.total);
      if (r.kind === 'TRANSCRIPTION_SECONDS') day.transcriptionMinutes += n / 60;
      else if (r.route === 'PRIVATE') day.privateTokens += n;
      else if (r.route === 'MANAGED') day.managedTokens += n;
      else if (r.route === 'BYOK') day.byokTokens += n;
    }
    return [...out.values()].map((d) => ({
      ...d,
      transcriptionMinutes: Math.round(d.transcriptionMinutes * 10) / 10,
    }));
  }
}

/** Days a lapsed period keeps its plan, so a late renewal webhook never drops a team to Free. */
const GRACE_MS = 3 * DAY;

/** A subscription counts while it's active (with grace), or until the end of a paid period. */
export function effectivePlan(subscription: Subscription | null, now = new Date()): PlanId {
  if (!subscription) return 'FREE';
  if (subscription.status === 'ACTIVE' || subscription.status === 'PAST_DUE') {
    const end = subscription.currentPeriodEnd;
    return end && end.getTime() + GRACE_MS < now.getTime() ? 'FREE' : subscription.plan;
  }
  return subscription.currentPeriodEnd && subscription.currentPeriodEnd > now
    ? subscription.plan
    : 'FREE';
}
