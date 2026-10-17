import { Inject, Injectable } from '@nestjs/common';
import type { MeetingBotProvider } from '@sotto/ai';
import type { MeetPlatform } from '@sotto/db';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { type BotReporter, type StandInPace, meetingBotFrom } from './bots.js';

/** In tests the stand-in moves fast: let in at once, a 4 s piece every 30 ms, gone by 0.6 s. */
const TEST_PACE: StandInPace = { admitAfterMs: 10, everyMs: 30, pieceMs: 4_000, maxMs: 600 };

/**
 * The notetaker's bot provider (`MEETING_BOT`), shared by the calendar (which sends bots and
 * takes them back) and the scheduler (which launches them and hears their reports). The
 * scheduler attaches itself as the in-process reporter for the stand-in bot.
 */
@Injectable()
export class NotetakerBots {
  readonly provider: MeetingBotProvider | null;
  readonly name: string;
  private reporter: BotReporter | null = null;
  private onDue: (() => void) | null = null;

  constructor(@Inject(APP_CONFIG) config: ApiConfig) {
    this.name = config.MEETING_BOT_NAME;
    this.provider = meetingBotFrom(
      config.MEETING_BOT,
      () => {
        if (!this.reporter) throw new Error('The notetaker scheduler isn’t running.');
        return this.reporter;
      },
      config.NODE_ENV === 'test' ? TEST_PACE : undefined,
    );
  }

  attach(reporter: BotReporter, onDue: () => void): void {
    this.reporter = reporter;
    this.onDue = onDue;
  }

  /** Something is due now (a bot sent to a call under way): launch it now, not on the next tick. */
  due(): void {
    this.onDue?.();
  }

  supports(platform: MeetPlatform | null): boolean {
    return Boolean(platform && this.provider?.platforms.includes(platform));
  }

  /** Asks a run to leave; a provider that can't be reached is no reason to fail the caller. */
  async leave(ref: string | null): Promise<void> {
    if (ref && this.provider) await this.provider.leave(ref).catch(() => undefined);
  }
}
