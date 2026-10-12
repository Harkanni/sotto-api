import { z } from 'zod';
import { FileSchema, SensitivitySchema } from '../files/schemas.js';

export const LiveInput = z.enum(['mic', 'tab', 'call']).meta({ id: 'LiveInput' });

export const StartLive = z
  .object({
    /** The meeting's name; "Live meeting" with the date when omitted. */
    title: z.string().trim().min(1).max(200).optional(),
    /** Where the meeting is saved: a collection you can edit, or unfiled when omitted. */
    collectionId: z.string().min(1).max(64).optional(),
    sensitivity: SensitivitySchema.optional(),
    /** What the app captures: the microphone, and on desktop Chromium a call's tab too. */
    inputs: z
      .array(z.enum(['mic', 'tab']))
      .min(1)
      .max(2),
  })
  .meta({ id: 'StartLive' });

export const ChunkQuery = z
  .object({ seq: z.coerce.number().int().min(0).max(100_000) })
  .meta({ id: 'LiveChunkQuery' });

export const LiveSegmentSchema = z
  .object({
    /** `seq.idx`: the chunk and the line within it; also the SSE event id. */
    id: z.string(),
    seq: z.number(),
    idx: z.number(),
    startMs: z.number(),
    endMs: z.number(),
    text: z.string(),
    speaker: z.string().nullable(),
  })
  .meta({ id: 'LiveSegment' });

export const LiveNotesSchema = z
  .object({
    summary: z.string(),
    points: z.array(z.string()),
    actions: z.array(z.object({ text: z.string(), owner: z.string().nullable() })),
  })
  .meta({ id: 'LiveNotes' });

export const LiveSessionSchema = z
  .object({
    id: z.string(),
    source: z.enum(['listen', 'bot']),
    status: z.enum(['connecting', 'live', 'ended', 'failed']),
    inputs: z.array(LiveInput),
    /** Audio received so far, and the next chunk number the api expects. */
    durationMs: z.number(),
    nextSeq: z.number(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    /** The person who started it: only they can send audio or end it. */
    startedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    canControl: z.boolean(),
    /** Who transcribes it live; `isMock` for the labelled stand-in engine. Null when unreachable. */
    transcriber: z.object({ engine: z.string(), isMock: z.boolean() }).nullable(),
    notes: LiveNotesSchema.nullable(),
    notesAt: z.string().nullable(),
    /** The last problem as a code ("transcriber_unreachable"); the capture carries on. */
    error: z.string().nullable(),
    /** The meeting it becomes. */
    file: FileSchema,
  })
  .meta({ id: 'LiveSession' });

export const ChunkResult = z
  .object({
    /** False when this chunk had already arrived (a retry): nothing changed. */
    accepted: z.boolean(),
    nextSeq: z.number(),
    durationMs: z.number(),
  })
  .meta({ id: 'LiveChunkResult' });

export const LiveSessionList = z
  .object({ items: z.array(LiveSessionSchema) })
  .meta({ id: 'LiveSessionList' });
