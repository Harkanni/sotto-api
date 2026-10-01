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
export interface EmbeddingProvider extends ProviderInfo {
  readonly capability: 'embedding';
  /** The model this instance embeds with; vectors are stored per model (one index per model). */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
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

export interface MeetingBotProvider extends ProviderInfo {
  readonly capability: 'meetingBot';
  readonly platforms: readonly MeetingPlatform[];
  join(input: { meetingUrl: string; platform: MeetingPlatform; botName: string }): Promise<{
    ref: string;
  }>;
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
