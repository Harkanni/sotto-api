import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export { PrismaClient, Prisma } from './generated/prisma/client.js';
export type {
  AuditLog,
  Chunk,
  Citation,
  Collection,
  CollectionPermission,
  File,
  Invite,
  MeetingInsights,
  Membership,
  Message,
  Conversation,
  Note,
  Passkey,
  PlaybackPosition,
  Session,
  Transcript,
  TranscriptSegment,
  User,
  Workspace,
} from './generated/prisma/client.js';
export {
  Access,
  AiRoute,
  FileKind,
  FileSource,
  FileStatus,
  Handedness,
  InviteStatus,
  MessageRole,
  MessageStatus,
  Role,
  Sensitivity,
} from './generated/prisma/enums.js';
export {
  assertModelId,
  ensureEmbeddingIndex,
  hnswIndexSql,
  indexNameFor,
  toVectorLiteral,
  writeEmbeddings,
  type EmbeddingRow,
  type RawExecutor,
} from './vectors.js';
export {
  CrossTenantWriteError,
  TENANT_MODELS,
  forWorkspace,
  scopeArgs,
  tenantTransaction,
  type TenantClient,
  type TenantModel,
} from './tenant.js';

/**
 * Prisma 7 talks to Postgres through a driver adapter (node-postgres here). Create one client per
 * process and reuse it; it pools connections internally.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}

/** Strip credentials before a URL goes anywhere near a log line. */
export function redactDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '<invalid url>';
  }
}
