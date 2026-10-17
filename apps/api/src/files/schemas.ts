import { z } from 'zod';
import { AccessSchema } from '../collections/collections.controller.js';

export const FileKindSchema = z.enum(['document', 'audio', 'note']).meta({ id: 'FileKind' });
export const FileStatusSchema = z
  .enum(['uploading', 'uploaded', 'transcribing', 'indexing', 'ready', 'failed'])
  .meta({ id: 'FileStatus' });
export const SensitivitySchema = z
  .enum(['internal', 'confidential', 'restricted'])
  .meta({ id: 'Sensitivity' });
export const FileSourceSchema = z
  .enum(['upload', 'recording', 'sample', 'import', 'written', 'live', 'bot'])
  .meta({ id: 'FileSource' });

export const FileSchema = z
  .object({
    id: z.string(),
    kind: FileKindSchema,
    source: FileSourceSchema,
    title: z.string(),
    status: FileStatusSchema,
    /** 0–1 within the current step, when the step reports it (transcription does). */
    progress: z.number().nullable(),
    /** Why processing failed, as a code ("extract_failed"); the web words it. */
    error: z.string().nullable(),
    sensitivity: SensitivitySchema,
    collection: z.object({ id: z.string(), name: z.string(), restricted: z.boolean() }).nullable(),
    owner: z.object({ id: z.string(), name: z.string() }).nullable(),
    mime: z.string(),
    sizeBytes: z.number(),
    durationMs: z.number().nullable(),
    pageCount: z.number().nullable(),
    pinned: z.boolean(),
    tags: z.array(z.string()),
    /** What you can do with it: view, edit (rename, move, tag, trash), manage (delete forever). */
    access: AccessSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    /** Set while it's in the trash. */
    deletedAt: z.iso.datetime().nullable(),
    /** When the trash empties it for good. */
    purgeAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'File' });
export type FileOut = z.infer<typeof FileSchema>;

export const FilePage = z
  .object({ items: z.array(FileSchema), nextCursor: z.string().nullable() })
  .meta({ id: 'FilePage' });

export const ListFilesQuery = z.object({
  /** A collection id, or "unfiled". Omit for everything you can see. */
  collection: z.string().min(1).max(64).optional(),
  kind: FileKindSchema.optional(),
  status: FileStatusSchema.optional(),
  /** Matches titles; searching inside files is Ask's job (Phase 5). */
  q: z.string().trim().max(200).optional(),
  /** true → the trash instead of the library. */
  trash: z.enum(['true', 'false']).optional(),
  pinned: z.enum(['true', 'false']).optional(),
  sort: z.enum(['recent', 'name']).default('recent'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
});
// No component id on query schemas: Swagger spreads them into parameters only when inline.
export type ListFilesQuery = z.infer<typeof ListFilesQuery>;

const Title = z
  .string()
  .trim()
  .min(1, 'Give it a name.')
  .max(120, 'Keep the name under 120 characters.');

const Tag = z
  .string()
  .trim()
  .min(1)
  .max(32, 'Keep tags under 32 characters.')
  .transform((t) => t.toLowerCase());

export const UpdateFile = z
  .object({
    title: Title.optional(),
    /** A collection id, or null to unfile it. */
    collectionId: z.string().min(1).max(64).nullable().optional(),
    tags: z.array(Tag).max(20, 'Up to 20 tags.').optional(),
    pinned: z.boolean().optional(),
    sensitivity: SensitivitySchema.optional(),
  })
  .meta({ id: 'UpdateFile' });

export const DownloadQuery = z.object({ inline: z.enum(['true', 'false']).default('false') });

export const DownloadLink = z
  .object({ url: z.string(), expiresAt: z.iso.datetime() })
  .meta({ id: 'DownloadLink' });

// ── Uploads ─────────────────────────────────────────────────────────────────────────────────

export const StartUpload = z
  .object({
    /** The file's name on the person's device; decides the type and the default title. */
    filename: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().min(1, 'This file is empty.'),
    /** What the browser says it is; used when the name has no extension (recordings). */
    mime: z.string().max(100).optional(),
    title: Title.optional(),
    /** Where it goes: a collection you can edit, or unfiled when omitted. */
    collectionId: z.string().min(1).max(64).optional(),
    sensitivity: SensitivitySchema.optional(),
    /** "recording" for the in-app recorder. */
    source: z.enum(['upload', 'recording']).default('upload'),
  })
  .meta({ id: 'StartUpload' });

export const PartUrl = z
  .object({ partNumber: z.number(), url: z.string() })
  .meta({ id: 'PartUrl' });

export const UploadSchema = z
  .object({
    file: FileSchema,
    /** Bytes per part; every part but the last is exactly this size. */
    partSize: z.number(),
    partCount: z.number(),
    /** Presigned URLs for the first parts; ask for more with POST /uploads/:id/parts. */
    parts: z.array(PartUrl),
    /** Parts storage already holds (resuming after an interruption). */
    uploadedParts: z.array(z.object({ partNumber: z.number(), etag: z.string() })),
  })
  .meta({ id: 'Upload' });

export const PartsRequest = z
  .object({ partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(100) })
  .meta({ id: 'PartsRequest' });

export const PartsResponse = z.object({ parts: z.array(PartUrl) }).meta({ id: 'PartsResponse' });

export const CompleteUpload = z
  .object({
    parts: z
      .array(
        z.object({
          partNumber: z.number().int().min(1).max(10_000),
          etag: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(10_000),
  })
  .meta({ id: 'CompleteUpload' });
