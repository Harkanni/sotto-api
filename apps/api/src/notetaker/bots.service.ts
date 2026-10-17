import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { BotJob } from '@sotto/ai';
import type { BotAssignment, BotStatus } from '@sotto/db';
import { atLeast } from '../auth/roles.js';
import type { Viewer } from '../collections/collections.service.js';
import { ApiException } from '../common/errors.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import { LiveService } from '../live/live.service.js';
import { NotetakerBots } from './bot-registry.js';
import type { BotReporter } from './bots.js';
import { CalendarService } from './calendar.service.js';
import { BotReport } from './schemas.js';
import { signBotToken, verifyWebhook } from './signing.js';
import type { NotetakerSwitch } from './switch.js';

const TICK_EVERY_MS = 15_000;
/** A bot left waiting to be let in this long gives up. */
const ADMIT_TIMEOUT_MS = 10 * 60_000;
/** Without an end time, a bot leaves after this long; with one, this long after it. */
const DEFAULT_CALL_MS = 2 * 3600_000;
const OVERRUN_MS = 30 * 60_000;
/** A bot's token outlives the call by an hour (pieces still uploading), then nothing. */
const TOKEN_GRACE_MS = 3600_000;

const ACTIVE: BotStatus[] = ['SCHEDULED', 'JOINING', 'IN_CALL'];

/**
 * The notetaker's lifecycle (ADR 0035): launches due bots (each claimed once, whatever the
 * number of api processes), hears their reports, starts and ends their live sessions, and puts
 * them right when something changed under them (the call was stopped in the app, the admins
 * turned bots off, a bot never got in).
 */
@Injectable()
export class BotsService implements BotReporter, NotetakerSwitch, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('notetaker');
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(CalendarService) private readonly calendar: CalendarService,
    @Inject(NotetakerBots) private readonly bots: NotetakerBots,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
  ) {
    this.bots.attach(this, () => void this.tick().catch(() => undefined));
  }

  onModuleInit(): void {
    if (this.config.NODE_ENV === 'test') return; // tests tick themselves (or are kicked)
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass of the scheduler; overlapping calls share the pass already running. */
  tick(now = new Date()): Promise<void> {
    this.ticking ??= this.pass(now).finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async pass(now: Date): Promise<void> {
    await this.calendar.syncAutoJoin(now);
    await this.offWhereTurnedOff();
    await this.launchDue(now);
    await this.expire(now);
    await this.reconcile(now);
  }

  // ── Launching ──────────────────────────────────────────────────────────────────────────────

  private job(assignment: BotAssignment, senderName: string): BotJob {
    const base = (this.config.MEETING_BOT_CALLBACK_URL ?? this.config.APP_URL).replace(/\/+$/, '');
    const leaveBy = new Date(
      (assignment.endsAt?.getTime() ?? assignment.joinAt.getTime() + DEFAULT_CALL_MS) + OVERRUN_MS,
    );
    const secret = this.config.MEETING_BOT_SECRET;
    return {
      assignmentId: assignment.id,
      meetingUrl: assignment.meetingUrl,
      platform: assignment.platform,
      botName: this.bots.name,
      announcement:
        `Hi, I’m ${this.bots.name}. I’m recording and transcribing this call for ` +
        `${senderName}’s notes in Sotto. Say if you’d rather I left.`,
      callback: {
        webhookUrl: `${base}/api/v1/webhooks/meeting-bot`,
        audioBaseUrl: `${base}/api/v1/live-sessions`,
        // The in-process stand-in needs no token; a real bot can't run without the secret.
        token: secret
          ? signBotToken(secret, assignment.id, new Date(leaveBy.getTime() + TOKEN_GRACE_MS))
          : '',
      },
      leaveBy,
    };
  }

  private async launchDue(now: Date): Promise<void> {
    const due = await this.prisma.client.botAssignment.findMany({
      where: {
        status: 'SCHEDULED',
        joinAt: { lte: now },
        OR: [{ endsAt: null }, { endsAt: { gt: now } }],
        workspace: { meetingBots: true },
      },
      include: { connection: { include: { user: { select: { name: true, email: true } } } } },
      orderBy: { joinAt: 'asc' },
      take: 20,
    });
    for (const assignment of due) {
      const provider = this.bots.provider;
      if (!provider || !this.bots.supports(assignment.platform)) {
        await this.settle(assignment.id, ['SCHEDULED'], 'SKIPPED', 'unavailable');
        continue;
      }
      // The claim: only one process moves it out of SCHEDULED, and only that one launches it.
      const { count } = await this.prisma.client.botAssignment.updateMany({
        where: { id: assignment.id, status: 'SCHEDULED' },
        data: { status: 'JOINING', error: null },
      });
      if (count === 0) continue;
      const user = assignment.connection.user;
      try {
        const { ref } = await provider.join(
          this.job(assignment, user.name || user.email.split('@')[0]!),
        );
        await this.prisma.client.botAssignment.updateMany({
          where: { id: assignment.id },
          data: { providerRef: ref },
        });
      } catch (error) {
        this.log.warn(`bot launch failed (${error instanceof Error ? error.name : 'error'})`);
        await this.settle(assignment.id, ['JOINING'], 'FAILED', 'launch_failed');
      }
    }
  }

  /** Calls that ended before a bot could go (no bot set up, or it was off) are marked missed. */
  private async expire(now: Date): Promise<void> {
    await this.prisma.client.botAssignment.updateMany({
      where: { status: 'SCHEDULED', endsAt: { lte: now } },
      data: { status: 'SKIPPED', error: 'missed' },
    });
  }

  /** Moves an assignment from one of `from` to `to`; false if someone else moved it first. */
  private async settle(
    id: string,
    from: BotStatus[],
    to: BotStatus,
    error: string | null,
  ): Promise<boolean> {
    const { count } = await this.prisma.client.botAssignment.updateMany({
      where: { id, status: { in: from } },
      data: { status: to, error },
    });
    return count > 0;
  }

  // ── Reports ────────────────────────────────────────────────────────────────────────────────

  /** The signed webhook: a real bot's reports. False for anything not signed with our secret. */
  async webhook(
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ liveSessionId: string | null } | null> {
    const secret = this.config.MEETING_BOT_SECRET;
    const one = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const body = rawBody?.toString('utf8') ?? '';
    if (
      !secret ||
      !verifyWebhook(
        secret,
        { timestamp: one('x-sotto-timestamp'), signature: one('x-sotto-signature') },
        body,
      )
    ) {
      return null;
    }
    let report: BotReport;
    try {
      report = BotReport.parse(JSON.parse(body));
    } catch {
      throw new ApiException(400, 'BAD_REPORT', 'That report isn’t one the api understands.');
    }
    return this.report(report);
  }

  async report(report: BotReport): Promise<{ liveSessionId: string | null }> {
    const assignment = await this.prisma.client.botAssignment.findUnique({
      where: { id: report.assignmentId },
      include: {
        connection: { select: { userId: true } },
        workspace: { select: { meetingBots: true } },
      },
    });
    if (!assignment) return { liveSessionId: null };

    switch (report.event) {
      case 'waiting':
        return { liveSessionId: null };

      case 'in_call': {
        if (assignment.status === 'IN_CALL' && assignment.liveSessionId) {
          return { liveSessionId: assignment.liveSessionId }; // a repeated report
        }
        // Taken back, failed or turned off while it was getting in: it should leave.
        if (assignment.status !== 'JOINING' || !assignment.workspace.meetingBots) {
          await this.bots.leave(assignment.providerRef);
          if (!assignment.workspace.meetingBots) {
            await this.settle(assignment.id, ['JOINING'], 'SKIPPED', 'bots_off');
          }
          return { liveSessionId: null };
        }
        let sessionId: string;
        try {
          const session = await this.live.startForBot({
            workspaceId: assignment.workspaceId,
            userId: assignment.connection.userId,
            title: assignment.title,
          });
          sessionId = session.id;
        } catch (error) {
          const quota = error instanceof ApiException && error.getStatus() === 402;
          await this.settle(assignment.id, ['JOINING'], 'FAILED', quota ? 'quota' : 'error');
          await this.bots.leave(assignment.providerRef);
          return { liveSessionId: null };
        }
        const { count } = await this.prisma.client.botAssignment.updateMany({
          where: { id: assignment.id, status: 'JOINING' },
          data: { status: 'IN_CALL', liveSessionId: sessionId, error: null },
        });
        if (count === 0) {
          // Something changed meanwhile (skipped, turned off): nothing was recorded yet.
          await this.live.endBySystem(assignment.workspaceId, sessionId).catch(() => undefined);
          await this.bots.leave(assignment.providerRef);
          return { liveSessionId: null };
        }
        return { liveSessionId: sessionId };
      }

      case 'left':
      case 'failed': {
        if (assignment.liveSessionId) {
          // Whatever was heard is saved, like Stop in the app.
          await this.live
            .endBySystem(assignment.workspaceId, assignment.liveSessionId)
            .catch(() => undefined);
        }
        const recorded = Boolean(assignment.liveSessionId);
        const reason = report.reason ?? (report.event === 'failed' ? 'error' : null);
        if (report.event === 'left' && recorded) {
          await this.settle(assignment.id, ['IN_CALL', 'JOINING'], 'DONE', null);
        } else if (report.event === 'left' && reason === 'stopped') {
          await this.settle(assignment.id, ['JOINING', 'SCHEDULED'], 'SKIPPED', null);
        } else {
          await this.settle(assignment.id, ACTIVE, 'FAILED', reason ?? 'error');
        }
        return { liveSessionId: null };
      }
    }
  }

  /** The person the bot records for, as a viewer, while they're still a member who can record. */
  private async senderOf(assignment: {
    workspaceId: string;
    connection: { userId: string };
  }): Promise<Viewer | null> {
    const membership = await this.prisma.client.membership.findUnique({
      where: {
        workspaceId_userId: {
          workspaceId: assignment.workspaceId,
          userId: assignment.connection.userId,
        },
      },
      select: { role: true },
    });
    if (!membership || !atLeast(membership.role, 'member')) return null;
    return {
      userId: assignment.connection.userId,
      role: membership.role,
      workspaceId: assignment.workspaceId,
    };
  }

  /** The stand-in's audio, through the same chunk intake as Listen and the real bot. */
  async audio(
    assignmentId: string,
    liveSessionId: string,
    seq: number,
    pcm: Buffer,
  ): Promise<{ ended: boolean }> {
    const assignment = await this.prisma.client.botAssignment.findUnique({
      where: { id: assignmentId },
      include: { connection: { select: { userId: true } } },
    });
    if (
      !assignment ||
      assignment.status !== 'IN_CALL' ||
      assignment.liveSessionId !== liveSessionId
    ) {
      return { ended: true };
    }
    const viewer = await this.senderOf(assignment);
    if (!viewer) return { ended: true };
    try {
      await this.live.chunk(viewer, liveSessionId, seq, pcm);
      return { ended: false };
    } catch (error) {
      if (error instanceof ApiException && error.getStatus() === 429) return { ended: false };
      if (error instanceof ApiException && [404, 409].includes(error.getStatus())) {
        return { ended: true };
      }
      throw error;
    }
  }

  // ── Putting things right ───────────────────────────────────────────────────────────────────

  /**
   * The admins turned the notetaker off (here or in another api process): calls not started yet
   * are skipped, bots on their way or in a call leave, and what they recorded is saved.
   */
  async turnedOff(workspaceId: string): Promise<number> {
    const active = await this.prisma.client.botAssignment.findMany({
      where: { workspaceId, status: { in: ACTIVE } },
    });
    for (const assignment of active) {
      if (assignment.status !== 'SCHEDULED') await this.bots.leave(assignment.providerRef);
      if (assignment.liveSessionId) {
        await this.live.endBySystem(workspaceId, assignment.liveSessionId).catch(() => undefined);
      }
      await this.settle(
        assignment.id,
        [assignment.status],
        assignment.status === 'IN_CALL' ? 'DONE' : 'SKIPPED',
        'bots_off',
      );
    }
    return active.length;
  }

  private async offWhereTurnedOff(): Promise<void> {
    const workspaces = await this.prisma.client.botAssignment.findMany({
      where: { status: { in: ACTIVE }, workspace: { meetingBots: false } },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
    });
    for (const { workspaceId } of workspaces) await this.turnedOff(workspaceId);
  }

  /**
   * A bot that never got in gives up; a bot whose call was stopped in the app (or ended after
   * ten quiet minutes) leaves.
   */
  private async reconcile(now: Date): Promise<void> {
    const waiting = await this.prisma.client.botAssignment.findMany({
      where: { status: 'JOINING', updatedAt: { lt: new Date(now.getTime() - ADMIT_TIMEOUT_MS) } },
    });
    for (const assignment of waiting) {
      await this.bots.leave(assignment.providerRef);
      await this.settle(assignment.id, ['JOINING'], 'FAILED', 'not_admitted');
    }
    const stopped = await this.prisma.client.botAssignment.findMany({
      where: { status: 'IN_CALL', liveSession: { status: { in: ['ENDED', 'FAILED'] } } },
    });
    for (const assignment of stopped) {
      await this.bots.leave(assignment.providerRef);
      await this.settle(assignment.id, ['IN_CALL'], 'DONE', null);
    }
  }
}
