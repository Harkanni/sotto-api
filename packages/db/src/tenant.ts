import type { PrismaClient } from './generated/prisma/client.js';

/**
 * Tables whose rows belong to one workspace. Request code reaches them only through
 * `forWorkspace`, so a forgotten filter can't leak another workspace's data. Add every new
 * tenant model here (packages/db/test/tenant.spec.ts checks the schema agrees).
 */
export const TENANT_MODELS = [
  'Membership',
  'Invite',
  'Collection',
  'CollectionPermission',
  'AuditLog',
] as const;

export type TenantModel = (typeof TENANT_MODELS)[number];

const tenantModels = new Set<string>(TENANT_MODELS);

/** Thrown when code tries to write a row into a different workspace through a scoped client. */
export class CrossTenantWriteError extends Error {
  constructor(model: string) {
    super(`Refused to write ${model} into another workspace`);
    this.name = 'CrossTenantWriteError';
  }
}

type Args = Record<string, unknown>;

function withWhere(args: Args, field: string, value: string): Args {
  const where = (args.where ?? {}) as Args;
  return { ...args, where: { ...where, [field]: value } };
}

function checkData(model: string, data: unknown, workspaceId: string): void {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (row && typeof row === 'object' && 'workspaceId' in row) {
      const value = (row as Args).workspaceId;
      if (value !== undefined && value !== workspaceId) throw new CrossTenantWriteError(model);
    }
  }
}

function stamp(model: string, data: unknown, workspaceId: string): unknown {
  checkData(model, data, workspaceId);
  if (Array.isArray(data)) return data.map((row: Args) => ({ ...row, workspaceId }));
  return { ...(data as Args), workspaceId };
}

/**
 * Adds the workspace to one operation's arguments. Exported for tests; use `forWorkspace`.
 *
 * Reads, updates and deletes get `workspaceId` in their `where`; creates get it in their data;
 * an update can't move a row to another workspace. The Workspace model itself is narrowed to
 * the one workspace. Raw SQL (`$queryRaw`) is not covered: it must filter by workspace itself.
 */
export function scopeArgs(model: string, operation: string, args: Args, workspaceId: string): Args {
  if (model === 'Workspace') {
    if (operation.startsWith('create')) throw new CrossTenantWriteError(model);
    return withWhere(args, 'id', workspaceId);
  }
  if (!tenantModels.has(model)) return args;

  switch (operation) {
    case 'create':
      return { ...args, data: stamp(model, args.data, workspaceId) };
    case 'createMany':
    case 'createManyAndReturn':
      return { ...args, data: stamp(model, args.data, workspaceId) };
    case 'upsert': {
      checkData(model, args.update, workspaceId);
      return {
        ...withWhere(args, 'workspaceId', workspaceId),
        create: stamp(model, args.create, workspaceId),
      };
    }
    case 'update':
    case 'updateMany':
    case 'updateManyAndReturn':
      checkData(model, args.data, workspaceId);
      return withWhere(args, 'workspaceId', workspaceId);
    default:
      // findUnique(OrThrow), findFirst(OrThrow), findMany, count, aggregate, groupBy, delete,
      // deleteMany: all take a `where`. findUnique accepts extra non-unique fields since Prisma 5.
      return withWhere(args, 'workspaceId', workspaceId);
  }
}

/** A Prisma client that only sees and writes one workspace's rows. */
export function forWorkspace(prisma: PrismaClient, workspaceId: string) {
  if (!workspaceId) throw new Error('forWorkspace needs a workspace id');
  return prisma.$extends({
    name: 'tenant',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return query(scopeArgs(model, operation, (args ?? {}) as Args, workspaceId) as never);
        },
      },
    },
  });
}

export type TenantClient = ReturnType<typeof forWorkspace>;
