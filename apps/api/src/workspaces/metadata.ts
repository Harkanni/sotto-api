import { z } from 'zod';

/**
 * The api's notes on a workspace, kept in Better Auth's `metadata` text column. Anything
 * unreadable is treated as empty rather than failing a request.
 */
const WorkspaceMeta = z.object({
  /** Set when onboarding loads the fictional sample content: sample key → collection id. */
  sample: z
    .object({
      loadedAt: z.string(),
      collections: z.record(z.string(), z.string()),
    })
    .optional(),
});

export type WorkspaceMeta = z.infer<typeof WorkspaceMeta>;

export function readWorkspaceMeta(raw: string | null | undefined): WorkspaceMeta {
  if (!raw) return {};
  try {
    const parsed = WorkspaceMeta.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeWorkspaceMeta(meta: WorkspaceMeta): string {
  return JSON.stringify(meta);
}
