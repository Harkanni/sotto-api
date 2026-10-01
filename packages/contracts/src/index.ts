import { z } from 'zod';

/**
 * Queue names and message shapes shared by api, worker and transcriber.
 * Bump `v` and keep the old shape readable when a message changes.
 * The Python transcriber mirrors these in services/transcriber/app/contracts.py.
 */
export const Queues = {
  fileUploaded: 'file.uploaded',
  transcribeRequested: 'transcribe.requested',
  transcribeCompleted: 'transcribe.completed',
} as const;

export type QueueName = (typeof Queues)[keyof typeof Queues];

export const FileKind = z.enum(['DOCUMENT', 'AUDIO', 'NOTE']);

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
});
export type TranscribeRequested = z.infer<typeof TranscribeRequested>;

export const TranscribeCompleted = z.discriminatedUnion('status', [
  z.object({
    v: z.literal(1),
    status: z.literal('ok'),
    fileId: z.string().min(1),
    workspaceId: z.string().min(1),
    transcriptKey: z.string().min(1),
    engine: z.string(),
    model: z.string(),
    durationMs: z.number().int().nonnegative(),
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
  [Queues.transcribeCompleted]: TranscribeCompleted,
} as const;
