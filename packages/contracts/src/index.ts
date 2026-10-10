import { z } from 'zod';

/**
 * Queue names and message shapes shared by api, worker and transcriber, plus the documents the
 * pipeline stores next to a file. Bump `v` and keep the old shape readable when a message
 * changes; optional fields can be added within a version.
 * The Python transcriber mirrors these in services/transcriber/app/contracts.py.
 */
export const Queues = {
  fileUploaded: 'file.uploaded',
  transcribeRequested: 'transcribe.requested',
  transcribeProgress: 'transcribe.progress',
  transcribeCompleted: 'transcribe.completed',
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];

/**
 * Messages that fail validation or keep failing land here (a dead-letter exchange routes them),
 * so nothing is lost and nothing loops forever.
 */
export const DEAD_LETTER_QUEUE = 'sotto.dead';

export const FileKind = z.enum(['DOCUMENT', 'AUDIO', 'NOTE']);
export const Sensitivity = z.enum(['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);

export const FileUploaded = z.object({
  v: z.literal(1),
  fileId: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: FileKind,
  storageKey: z.string().min(1),
  mime: z.string().min(1),
});
export type FileUploaded = z.infer<typeof FileUploaded>;

export const TranscribeRequested = z.object({
  v: z.literal(1),
  fileId: z.string().min(1),
  workspaceId: z.string().min(1),
  storageKey: z.string().min(1),
  language: z.string().optional(),
  /** Where the transcriber writes its outputs (transcript.json, peaks.json). */
  outputPrefix: z.string().min(1).optional(),
  /**
   * The file's label. A transcriber whose engine sends audio outside the cluster refuses
   * RESTRICTED files (BRIEF §3), failing with `restricted_engine`.
   */
  sensitivity: Sensitivity.optional(),
});
export type TranscribeRequested = z.infer<typeof TranscribeRequested>;

/** Sent every few seconds while a recording is transcribed; drives the status ring. */
export const TranscribeProgress = z.object({
  v: z.literal(1),
  fileId: z.string().min(1),
  workspaceId: z.string().min(1),
  progress: z.number().min(0).max(1),
});
export type TranscribeProgress = z.infer<typeof TranscribeProgress>;

export const TranscribeCompleted = z.discriminatedUnion('status', [
  z.object({
    v: z.literal(1),
    status: z.literal('ok'),
    fileId: z.string().min(1),
    workspaceId: z.string().min(1),
    transcriptKey: z.string().min(1),
    /** Waveform peaks for the player, when the transcriber made them. */
    peaksKey: z.string().min(1).optional(),
    engine: z.string(),
    model: z.string(),
    durationMs: z.number().int().nonnegative(),
    isMock: z.boolean().optional(),
  }),
  z.object({
    v: z.literal(1),
    status: z.literal('failed'),
    fileId: z.string().min(1),
    workspaceId: z.string().min(1),
    engine: z.string(),
    // A short machine-readable reason. Never document content.
    error: z.string().max(200),
  }),
]);
export type TranscribeCompleted = z.infer<typeof TranscribeCompleted>;

export const messageSchemas = {
  [Queues.fileUploaded]: FileUploaded,
  [Queues.transcribeRequested]: TranscribeRequested,
  [Queues.transcribeProgress]: TranscribeProgress,
  [Queues.transcribeCompleted]: TranscribeCompleted,
} as const;

// ── Stored documents (object storage, next to the original) ─────────────────────────────────

/** `transcript.json`: what the transcriber produced. Mirrors TranscriptionResult in Python. */
export const TranscriptSegmentDoc = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
  speaker: z.string().nullish(),
});
export const TranscriptDocument = z.object({
  engine: z.string(),
  model: z.string(),
  language: z.string(),
  durationMs: z.number().int().nonnegative(),
  isMock: z.boolean().default(false),
  segments: z.array(TranscriptSegmentDoc),
});
export type TranscriptDocument = z.infer<typeof TranscriptDocument>;

/** `pages.json`: a document's text, page by page (one page for formats without pages). */
export const PagesDocument = z.object({
  pages: z.array(z.object({ page: z.number().int().positive(), text: z.string() })),
});
export type PagesDocument = z.infer<typeof PagesDocument>;

/** `peaks.json`: loudness per bucket (0–1), for drawing the player's waveform. */
export const PeaksDocument = z.object({
  durationMs: z.number().int().nonnegative(),
  peaks: z.array(z.number().min(0).max(1)).max(4_096),
});
export type PeaksDocument = z.infer<typeof PeaksDocument>;

// ── Meeting insights ────────────────────────────────────────────────────────────────────────

/** Decisions, action items, open questions and chapters, as the worker stores them. */
export const MeetingInsightsBody = z.object({
  summary: z.string(),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      text: z.string(),
      /** As said in the meeting ("Tunde"); matched to members later, never guessed. */
      owner: z.string().nullish(),
      /** As said ("Friday", "2026-10-09"); null when no date was mentioned. */
      due: z.string().nullish(),
      /** Where in the recording it came up. */
      atMs: z.number().int().nonnegative().nullish(),
    }),
  ),
  openQuestions: z.array(z.string()),
  chapters: z.array(z.object({ title: z.string(), startMs: z.number().int().nonnegative() })),
});
export type MeetingInsightsBody = z.infer<typeof MeetingInsightsBody>;

// ── Live status (worker → Redis → api → browser over SSE) ───────────────────────────────────

/** Redis channel per workspace; the api relays it to that workspace's /events streams. */
export function eventsChannel(workspaceId: string): string {
  return `sotto:events:${workspaceId}`;
}

export const FileStatusName = z.enum([
  'UPLOADING',
  'UPLOADED',
  'TRANSCRIBING',
  'INDEXING',
  'READY',
  'FAILED',
]);

/**
 * One file changed. Carries no title or content; clients refetch through the API (which checks
 * access) to learn more. `collectionId` and `ownerId` stay server-side: the api uses them to send
 * each event only to people who can see the file, then strips them (BrowserFileEvent).
 */
export const FileEvent = z.object({
  type: z.literal('file'),
  fileId: z.string().min(1),
  collectionId: z.string().nullable(),
  ownerId: z.string().nullable(),
  deleted: z.boolean().default(false),
  status: FileStatusName,
  progress: z.number().min(0).max(1).nullable(),
  error: z.string().max(200).nullable(),
  /** Trashed, restored, renamed, moved or deleted: the client refetches lists. */
  change: z.enum(['status', 'updated', 'removed']).default('status'),
  at: z.iso.datetime(),
});
export type FileEvent = z.infer<typeof FileEvent>;

/** What the browser receives: the event without the fields used for filtering. */
export const BrowserFileEvent = FileEvent.omit({
  collectionId: true,
  ownerId: true,
  deleted: true,
});
export type BrowserFileEvent = z.infer<typeof BrowserFileEvent>;
export * from './plans.js';
