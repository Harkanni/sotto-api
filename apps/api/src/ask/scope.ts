import { z } from 'zod';

/**
 * Where answers and search results come from (BRIEF §4): the whole workspace, one collection, or
 * files picked with @-mentions, optionally only documents or only meetings. Whatever the scope,
 * the viewer's access still applies: a scope can only narrow what they can open, never widen it.
 */
export const AskScope = z
  .object({
    /** One collection; null or absent means the whole workspace. */
    collectionId: z.string().min(1).max(64).nullish(),
    /** Specific files (@-mentions). When set, only these are searched. */
    fileIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    /** Documents (and notes), meetings, or both (absent). */
    kind: z.enum(['documents', 'meetings']).optional(),
    /**
     * A call being captured live: its transcript so far is offered too, beside the rest of the
     * scope (it isn't indexed until the call ends). Only someone who can open it may use it.
     */
    liveSessionId: z.string().min(1).max(64).optional(),
  })
  .meta({ id: 'AskScope' });
export type AskScope = z.infer<typeof AskScope>;

export const WHOLE_WORKSPACE: AskScope = {};

/** The file kinds a scope covers, as the database names them. */
export function kindsOf(scope: AskScope): ('DOCUMENT' | 'AUDIO' | 'NOTE')[] {
  if (scope.kind === 'documents') return ['DOCUMENT', 'NOTE'];
  if (scope.kind === 'meetings') return ['AUDIO'];
  return ['DOCUMENT', 'AUDIO', 'NOTE'];
}

/** Reads a stored scope (Conversation.scope), dropping anything that no longer parses. */
export function storedScope(value: unknown): AskScope {
  const parsed = AskScope.safeParse(value);
  return parsed.success ? parsed.data : WHOLE_WORKSPACE;
}
