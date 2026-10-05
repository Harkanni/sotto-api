import type { Access, Prisma, Sensitivity } from '@sotto/db';
import { accessAtLeast, atLeast, collectionAccess, type Grant } from '../auth/roles.js';
import { type Viewer, visibleTo } from '../collections/collections.service.js';

/**
 * Who sees a file and what they may do with it (ADR 0016). A file in a collection follows the
 * collection (ADR 0012); an unfiled file is like an open collection, except members edit only
 * their own. Trashed unfiled files are visible to their owner and admins only, so a file from a
 * deleted restricted collection never surfaces for everyone.
 *
 * `fileVisibleTo` is part of every query (permissions live inside SQL); `fileAccess` decides one
 * file's actions and mirrors it exactly. Both are unit-tested together.
 */
export function fileVisibleTo(viewer: Viewer): Prisma.FileWhereInput {
  // A file still uploading belongs to its uploader until it's complete.
  const notSomeoneElsesUpload: Prisma.FileWhereInput = {
    OR: [{ status: { not: 'UPLOADING' } }, { ownerId: viewer.userId }],
  };
  if (atLeast(viewer.role, 'admin')) return notSomeoneElsesUpload;
  return {
    AND: [
      notSomeoneElsesUpload,
      {
        OR: [
          { collectionId: null, deletedAt: null },
          { collectionId: null, ownerId: viewer.userId },
          { collection: { is: visibleTo(viewer) } },
        ],
      },
    ],
  };
}

export interface FileForAccess {
  collectionId: string | null;
  ownerId: string | null;
  collection: { restricted: boolean; permissions: Grant[] } | null;
}

/** What `viewer` may do with one file: VIEW, EDIT (rename, move, tag, trash), MANAGE, or null. */
export function fileAccess(viewer: Viewer, file: FileForAccess): Access | null {
  if (atLeast(viewer.role, 'admin')) return 'MANAGE';
  if (!file.collectionId || !file.collection) {
    if (viewer.role === 'viewer') return 'VIEW';
    return file.ownerId === viewer.userId ? 'MANAGE' : 'VIEW';
  }
  return collectionAccess(viewer, file.collection, file.collection.permissions);
}

/**
 * Permanent delete can't be undone, so it needs Manage, or being the file's owner with Edit.
 */
export function canDeleteForever(viewer: Viewer, file: FileForAccess, access: Access | null) {
  if (accessAtLeast(access, 'MANAGE')) return true;
  return accessAtLeast(access, 'EDIT') && file.ownerId === viewer.userId;
}

/**
 * Labelling a file Restricted keeps it away from outside AI; anyone who edits the file may raise
 * the label. Lowering it from Restricted could send it out, so only admins and owners may.
 */
export function canRelabel(viewer: Viewer, from: Sensitivity, to: Sensitivity): boolean {
  if (from === to) return true;
  if (from === 'RESTRICTED') return atLeast(viewer.role, 'admin');
  return true;
}

/** The include that loads what `fileAccess` needs, scoped to the viewer's grants. */
export function accessInclude(viewer: Viewer) {
  return {
    collection: {
      select: {
        id: true,
        name: true,
        restricted: true,
        permissions: {
          where: { OR: [{ userId: viewer.userId }, { role: viewer.role }] },
          select: { userId: true, role: true, access: true },
        },
      },
    },
  } satisfies Prisma.FileInclude;
}
