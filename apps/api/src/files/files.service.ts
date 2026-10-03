import { Inject, Injectable } from '@nestjs/common';
import {
  type Access,
  type File,
  type FileKind,
  type FileStatus,
  type Prisma,
  type Sensitivity,
  forWorkspace,
} from '@sotto/db';
import { ApiException } from '../common/errors.js';
import type { Viewer } from '../collections/collections.service.js';
import { PrismaService } from '../core.module.js';
import { EventPublisher } from '../infra.module.js';
import { accessAtLeast } from '../auth/roles.js';
import { accessInclude, fileAccess, fileVisibleTo } from './access.js';
import type { FileOut, ListFilesQuery } from './schemas.js';

/** How long trashed files stay before they're deleted for good (BRIEF §4). */
export const TRASH_DAYS = 30;
const DAY = 86_400_000;

type Loaded = File & {
  collection: {
    id: string;
    name: string;
    restricted: boolean;
    permissions: { userId: string | null; role: Viewer['role'] | null; access: Access }[];
  } | null;
  owner: { id: string; name: string; email: string } | null;
};

const lower = <T extends string>(value: T) => value.toLowerCase() as Lowercase<T>;
const upper = <T extends string>(value: T) => value.toUpperCase() as Uppercase<T>;

export function toKind(kind: 'document' | 'audio' | 'note'): FileKind {
  return upper(kind);
}
export function toStatus(status: Lowercase<FileStatus>): FileStatus {
  return upper(status);
}
export function toSensitivity(s: Lowercase<Sensitivity>): Sensitivity {
  return upper(s);
}

/** Keyset cursors: the sort key of the last row seen, opaque to clients. */
interface Cursor {
  k: string;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof value.k === 'string' && typeof value.id === 'string') return value;
  } catch {
    // fall through
  }
  throw new ApiException(400, 'INVALID_CURSOR', 'This list is out of date. Pull to refresh.');
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EventPublisher) private readonly events: EventPublisher,
  ) {}

  db(workspaceId: string) {
    return forWorkspace(this.prisma.client, workspaceId);
  }

  include(viewer: Viewer) {
    return {
      ...accessInclude(viewer),
      owner: { select: { id: true, name: true, email: true } },
    } satisfies Prisma.FileInclude;
  }

  present(file: Loaded, access: Access): FileOut {
    return {
      id: file.id,
      kind: lower(file.kind),
      source: lower(file.source),
      title: file.title,
      status: lower(file.status),
      progress: file.progress,
      error: file.error,
      sensitivity: lower(file.sensitivity),
      collection: file.collection
        ? {
            id: file.collection.id,
            name: file.collection.name,
            restricted: file.collection.restricted,
          }
        : null,
      owner: file.owner
        ? { id: file.owner.id, name: file.owner.name || file.owner.email.split('@')[0]! }
        : null,
      mime: file.mime,
      sizeBytes: Number(file.sizeBytes),
      durationMs: file.durationMs,
      pageCount: file.pageCount,
      pinned: file.pinned,
      tags: file.tags,
      access: lower(access),
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
      deletedAt: file.deletedAt?.toISOString() ?? null,
      purgeAt: file.deletedAt
        ? new Date(file.deletedAt.getTime() + TRASH_DAYS * DAY).toISOString()
        : null,
    };
  }

  /**
   * One file the viewer can see, with their access. 404 when it doesn't exist or is hidden, so a
   * restricted file's existence isn't revealed. Trashed files only when `trashed` allows them.
   */
  async open(viewer: Viewer, id: string, options: { trashed?: 'exclude' | 'include' } = {}) {
    const file = await this.db(viewer.workspaceId).file.findFirst({
      where: {
        AND: [
          { id },
          fileVisibleTo(viewer),
          options.trashed === 'include' ? {} : { deletedAt: null },
        ],
      },
      include: this.include(viewer),
    });
    const access = file ? fileAccess(viewer, file) : null;
    if (!file || !access) {
      throw new ApiException(404, 'NOT_FOUND', 'This file doesn’t exist, or you can’t open it.');
    }
    return { file: file as Loaded, access };
  }

  async require(
    viewer: Viewer,
    id: string,
    minimum: Access,
    message: string,
    options: { trashed?: 'exclude' | 'include' } = {},
  ) {
    const opened = await this.open(viewer, id, options);
    if (!accessAtLeast(opened.access, minimum)) {
      throw new ApiException(403, 'ACCESS_REQUIRED', message);
    }
    return opened;
  }

  async list(viewer: Viewer, query: ListFilesQuery) {
    const where: Prisma.FileWhereInput[] = [fileVisibleTo(viewer)];
    where.push(query.trash === 'true' ? { deletedAt: { not: null } } : { deletedAt: null });
    if (query.collection === 'unfiled') where.push({ collectionId: null });
    else if (query.collection) where.push({ collectionId: query.collection });
    if (query.kind) where.push({ kind: toKind(query.kind) });
    if (query.status) where.push({ status: toStatus(query.status) });
    if (query.pinned) where.push({ pinned: query.pinned === 'true' });
    if (query.q) where.push({ title: { contains: query.q, mode: 'insensitive' } });

    // Keyset paging: stable under inserts, and cheap at any depth.
    const cursor = decodeCursor(query.cursor);
    const byName = query.sort === 'name';
    if (cursor) {
      where.push(
        byName
          ? {
              OR: [{ title: { gt: cursor.k } }, { title: cursor.k, id: { gt: cursor.id } }],
            }
          : {
              OR: [
                { updatedAt: { lt: new Date(cursor.k) } },
                { updatedAt: new Date(cursor.k), id: { lt: cursor.id } },
              ],
            },
      );
    }

    const rows = (await this.db(viewer.workspaceId).file.findMany({
      where: { AND: where },
      include: this.include(viewer),
      orderBy: byName ? [{ title: 'asc' }, { id: 'asc' }] : [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    })) as Loaded[];

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeCursor({ k: byName ? last.title : last.updatedAt.toISOString(), id: last.id })
        : null;
    return {
      items: page.flatMap((f) => {
        const access = fileAccess(viewer, f);
        return access ? [this.present(f, access)] : [];
      }),
      nextCursor,
    };
  }

  /** Tells the workspace's open screens that a file changed (live status, lists). */
  emit(
    file: Pick<
      File,
      | 'id'
      | 'workspaceId'
      | 'collectionId'
      | 'ownerId'
      | 'status'
      | 'progress'
      | 'error'
      | 'deletedAt'
    >,
    change: 'status' | 'updated' | 'removed',
  ): Promise<void> {
    return this.events.file(file.workspaceId, {
      fileId: file.id,
      collectionId: file.collectionId,
      ownerId: file.ownerId,
      deleted: Boolean(file.deletedAt),
      status: file.status,
      progress: file.progress,
      error: file.error,
      change,
    });
  }
}
