import { randomUUID } from 'node:crypto';
import type { BotJob, MeetingBotProvider, MeetingPlatform } from '@sotto/ai';
import type { BotReport } from './schemas.js';

/**
 * Meeting bots (ADR 0035). `MEETING_BOT` picks the provider: `sample`, the labelled stand-in
 * below, or (M7) `meet`, the self-hosted Google Meet bot. Unset: the notetaker is unavailable
 * and the app says so.
 */

/** What the stand-in bot, running inside the api, reports instead of calling the webhook. */
export interface BotReporter {
  report(report: BotReport): Promise<{ liveSessionId: string | null }>;
  /** One piece of the call's audio; `ended` once the meeting stopped taking it. */
  audio(
    assignmentId: string,
    liveSessionId: string,
    seq: number,
    pcm: Buffer,
  ): Promise<{ ended: boolean }>;
}

export interface StandInPace {
  /** How long it "waits to be let in". */
  admitAfterMs: number;
  /** How often it sends a piece of audio, and how long each piece is. */
  everyMs: number;
  pieceMs: number;
  /** It leaves by then whatever the call's end time (a stand-in shouldn't run all day). */
  maxMs: number;
}

const REAL_TIME: StandInPace = {
  admitAfterMs: 3_000,
  everyMs: 4_000,
  pieceMs: 4_000,
  maxMs: 30 * 60_000,
};

/**
 * A piece of made-up call audio: 16 kHz mono PCM16, a soft tone for the first moment then
 * quiet, so the meter moves and the transcriber has something to take. Nobody is speaking.
 */
export function standInAudio(seq: number, ms: number): Buffer {
  const samples = Math.round(ms * 16);
  const pcm = Buffer.alloc(samples * 2);
  const toneSamples = Math.min(samples, 16 * 600);
  const pitch = 196 + (seq % 4) * 49; // a little tune, piece by piece
  for (let i = 0; i < toneSamples; i++) {
    const fade = Math.min(1, i / 800, (toneSamples - i) / 800);
    pcm.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * pitch * i) / 16_000) * 2_400 * fade),
      i * 2,
    );
  }
  return pcm;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The labelled stand-in notetaker: it joins no real call. Sent to a call, it "asks to be let
 * in", reports `in_call`, then sends made-up audio through the same live path a real bot uses,
 * so everything after it (Live now, the transcript, notes, the saved meeting) runs for real and
 * shows as Mock. For tests and the demo until the Meet bot runs (M7).
 */
export class StandInBot implements MeetingBotProvider {
  readonly id = 'sample';
  readonly label = 'Stand-in notetaker (joins no real call)';
  readonly capability = 'meetingBot' as const;
  readonly dataLocation = 'IN_CLUSTER' as const;
  readonly isMock = true;
  readonly platforms: readonly MeetingPlatform[] = ['MEET', 'ZOOM', 'TEAMS'];
  private readonly runs = new Map<string, AbortController>();

  constructor(
    private readonly reporter: () => BotReporter,
    private readonly pace: StandInPace = REAL_TIME,
  ) {}

  /** Runs still going (tests wait on them). */
  get running(): number {
    return this.runs.size;
  }

  async join(job: BotJob): Promise<{ ref: string }> {
    const ref = `sample:${randomUUID()}`;
    const stop = new AbortController();
    this.runs.set(ref, stop);
    void this.run(job, stop.signal)
      .catch(() =>
        this.reporter()
          .report({ assignmentId: job.assignmentId, event: 'failed', reason: 'error' })
          .catch(() => undefined),
      )
      .finally(() => this.runs.delete(ref));
    return { ref };
  }

  async leave(ref: string): Promise<void> {
    this.runs.get(ref)?.abort();
  }

  private async run(job: BotJob, signal: AbortSignal): Promise<void> {
    const reporter = this.reporter();
    await reporter.report({ assignmentId: job.assignmentId, event: 'waiting' });
    await sleep(this.pace.admitAfterMs, signal);
    if (signal.aborted) {
      await reporter.report({ assignmentId: job.assignmentId, event: 'left', reason: 'stopped' });
      return;
    }
    const { liveSessionId } = await reporter.report({
      assignmentId: job.assignmentId,
      event: 'in_call',
    });
    // Refused at the door (the notetaker was turned off, or the allowance is used up).
    if (!liveSessionId) return;
    const until = Math.min(job.leaveBy.getTime(), Date.now() + this.pace.maxMs);
    let reason: BotReport['reason'] = 'meeting_ended';
    for (let seq = 0; Date.now() < until; seq++) {
      await sleep(this.pace.everyMs, signal);
      if (signal.aborted) {
        reason = 'stopped';
        break;
      }
      const { ended } = await reporter.audio(
        job.assignmentId,
        liveSessionId,
        seq,
        standInAudio(seq, this.pace.pieceMs),
      );
      if (ended) {
        reason = 'stopped';
        break;
      }
    }
    await reporter.report({ assignmentId: job.assignmentId, event: 'left', reason });
  }
}

/** The bot provider `MEETING_BOT` names, or null when the notetaker isn't set up. */
export function meetingBotFrom(
  setting: string | undefined,
  reporter: () => BotReporter,
  pace?: StandInPace,
): MeetingBotProvider | null {
  if (setting === 'sample') return new StandInBot(reporter, pace);
  return null;
}
