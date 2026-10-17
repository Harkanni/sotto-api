/**
 * Provider interfaces. Every AI capability in Sotto goes through one of these, so models and
 * vendors can be swapped by configuration (ADR 0002). Vendor SDKs are only imported inside
 * adapters in this package.
 */

/** Where data goes when a provider is called. Privacy rules key off this, never off vendor names. */
export type DataLocation = 'IN_CLUSTER' | 'THIRD_PARTY';

export type Sensitivity = 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

export type Capability = 'chat' | 'embedding' | 'transcription' | 'diarization' | 'meetingBot';

export interface ProviderInfo {
  /** Stable id used in config, e.g. "ollama", "vllm", "anthropic", "faster-whisper". */
  readonly id: string;
  /** Human label for the admin UI and the data-route badge. */
  readonly label: string;
  readonly capability: Capability;
  readonly dataLocation: DataLocation;
  /** True for labelled mocks. The UI must show a "mock" badge when this is set. */
  readonly isMock?: boolean;
}

// ── Chat ──────────────────────────────────────────────────────────────
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask for a single JSON object (servers that support it constrain their output). */
  json?: boolean;
  signal?: AbortSignal;
}

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number } };

export interface ChatProvider extends ProviderInfo {
  readonly capability: 'chat';
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

// ── Embeddings ────────────────────────────────────────────────────────
export interface EmbedOptions {
  /** Passages being indexed, or a question being searched (some models embed them differently). */
  purpose?: 'document' | 'query';
  signal?: AbortSignal;
}

export interface EmbeddingProvider extends ProviderInfo {
  readonly capability: 'embedding';
  /** The model this instance embeds with; vectors are stored per model (one index per model). */
  readonly model: string;
  /** The vector size, or 0 until the first call reveals it. */
  readonly dimensions: number;
  embed(texts: string[], options?: EmbedOptions): Promise<number[][]>;
}

// ── Transcription ─────────────────────────────────────────────────────
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionResult {
  language: string;
  model: string;
  segments: TranscriptSegment[];
}

export interface TranscriptionProvider extends ProviderInfo {
  readonly capability: 'transcription';
  transcribe(input: {
    /** A short-lived signed URL or internal storage key; never raw audio in a log line. */
    audioRef: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<TranscriptionResult>;
}

// ── Speaker labels ────────────────────────────────────────────────────
export interface DiarizationProvider extends ProviderInfo {
  readonly capability: 'diarization';
  diarize(input: {
    audioRef: string;
    signal?: AbortSignal;
  }): Promise<Array<{ startMs: number; endMs: number; speaker: string }>>;
}

// ── Meeting bot (Phase 7) ─────────────────────────────────────────────
export type MeetingPlatform = 'MEET' | 'ZOOM' | 'TEAMS';

/**
 * One call to join (ADR 0035). The bot reports what happens on the signed webhook and, once
 * it's let in, sends the call's audio to the live session the webhook's answer names, the same
 * chunk API as Listen mode, with `Authorization: Bot <token>`.
 */
export interface BotJob {
  /** The assignment this run is for; every report names it. */
  assignmentId: string;
  meetingUrl: string;
  platform: MeetingPlatform;
  /** Shown to everyone in the call ("Sotto Notetaker"). */
  botName: string;
  /** Posted in the meeting chat when the bot is let in, so everyone knows it's recording. */
  announcement: string;
  /** Where to report (`POST`, signed) and send audio, and the token that lets it. */
  callback: { webhookUrl: string; audioBaseUrl: string; token: string };
  /** Leave by then even if the call carries on. */
  leaveBy: Date;
}

export interface MeetingBotProvider extends ProviderInfo {
  readonly capability: 'meetingBot';
  readonly platforms: readonly MeetingPlatform[];
  /** Starts a run; resolves with the provider's reference for it once it's on its way. */
  join(job: BotJob): Promise<{ ref: string }>;
  /** Asks a run to leave the call (or never join). Safe to call more than once. */
  leave(ref: string): Promise<void>;
}

export interface ProviderByCapability {
  chat: ChatProvider;
  embedding: EmbeddingProvider;
  transcription: TranscriptionProvider;
  diarization: DiarizationProvider;
  meetingBot: MeetingBotProvider;
}

export type AnyProvider = ProviderByCapability[Capability];
