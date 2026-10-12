import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type ApiConfig } from '../config.js';

const Segment = z.object({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  text: z.string(),
  speaker: z.string().nullish(),
});

const Result = z.object({
  engine: z.string(),
  model: z.string(),
  durationMs: z.number().int().min(0),
  isMock: z.boolean().default(false),
  segments: z.array(Segment),
});
export type LiveTranscript = z.infer<typeof Result>;

const Engines = z.object({
  active: z.string(),
  model: z.string(),
  dataLocation: z.enum(['IN_CLUSTER', 'THIRD_PARTY']),
  isMock: z.boolean(),
});
export type EngineInfo = z.infer<typeof Engines>;

/** Why a chunk wasn't transcribed, as a code for logs and the session's `error`. */
export class TranscriberError extends Error {
  constructor(readonly code: 'transcriber_unreachable' | 'transcriber_failed' | 'engine_outside') {
    super(code);
  }
}

/** How long one chunk may take: a few seconds of audio, but the first call may load a model. */
const CHUNK_TIMEOUT_MS = 60_000;
/** The engine doesn't change while the transcriber runs; ask again now and then in case it restarted. */
const ENGINE_TTL_MS = 60_000;

/**
 * The transcriber's direct endpoint (`POST /v1/transcribe`), used for live chunks: a few seconds
 * of audio each, so the queue's round trip would only add latency. Recorded files still go
 * through the queue. The same engine (TRANSCRIBER_ENGINE) answers both, so a live transcript and
 * the saved meeting's come from one place, inside the cluster unless the engine says otherwise.
 */
@Injectable()
export class LiveTranscriber {
  private engineInfo: { at: number; info: EngineInfo } | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: ApiConfig) {}

  /** The active engine, or null when the transcriber can't be reached. */
  async engine(): Promise<EngineInfo | null> {
    if (this.engineInfo && Date.now() - this.engineInfo.at < ENGINE_TTL_MS) {
      return this.engineInfo.info;
    }
    try {
      const res = await fetch(new URL('/v1/engines', this.config.TRANSCRIBER_URL), {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      const info = Engines.parse(await res.json());
      this.engineInfo = { at: Date.now(), info };
      return info;
    } catch {
      return null;
    }
  }

  /**
   * Transcribes one WAV chunk. `inClusterOnly` (Restricted captures) refuses an engine that
   * would send audio outside, the same rule as Restricted files in the pipeline.
   */
  async transcribe(
    wav: Buffer,
    options: { language?: string | null; inClusterOnly: boolean },
  ): Promise<LiveTranscript> {
    if (options.inClusterOnly) {
      const engine = await this.engine();
      if (!engine) throw new TranscriberError('transcriber_unreachable');
      if (engine.dataLocation !== 'IN_CLUSTER') throw new TranscriberError('engine_outside');
    }
    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'chunk.wav');
    if (options.language) form.append('language', options.language);
    let res: Response;
    try {
      res = await fetch(new URL('/v1/transcribe', this.config.TRANSCRIBER_URL), {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
    } catch {
      throw new TranscriberError('transcriber_unreachable');
    }
    if (!res.ok) throw new TranscriberError('transcriber_failed');
    try {
      return Result.parse(await res.json());
    } catch {
      throw new TranscriberError('transcriber_failed');
    }
  }
}
