import { Inject, Injectable } from '@nestjs/common';
import { type Access, Prisma, type Role, forWorkspace } from '@sotto/db';
import { ApiException } from '../common/errors.js';
import { PrismaService } from '../core.module.js';
import { accessAtLeast, atLeast, collectionAccess } from '../auth/roles.js';

export interface Viewer {
  userId: string;
  role: Role;
  workspaceId: string;
}

/**
 * Which collections a person may see, as a Prisma filter that becomes part of the SQL (CLAUDE.md:
 * permission filters live inside the query). Owners and admins see everything; everyone else
 * sees open collections and the restricted ones a grant names them in, by person or by role.
 */
export function visibleTo(viewer: Viewer): Prisma.CollectionWhereInput {
  if (atLeast(viewer.role, 'admin')) return {};
  return {
    OR: [
      { restricted: false },
      {
        permissions: {
          some: { OR: [{ userId: viewer.userId }, { role: viewer.role }] },
        },
      },
    ],
  };
}

/** The grants that can apply to this person (theirs and their role's), for computing access. */
export function grantsFor(viewer: Viewer) {
  return {
    where: { OR: [{ userId: viewer.userId }, { role: viewer.role }] },
    select: { userId: true, role: true, access: true },
  } satisfies Prisma.Collection$permissionsArgs;
}

@Injectable()
export class CollectionsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  db(workspaceId: string) {
    return forWorkspace(this.prisma.client, workspaceId);
  }

  /**
   * One collection the person can see, with their access; 404 when it doesn't exist or is
   * hidden from them (a restricted collection's existence isn't revealed).
   */
  async open(viewer: Viewer, id: string) {
    const collection = await this.db(viewer.workspaceId).collection.findFirst({
      where: { id, ...visibleTo(viewer) },
      select: {
        id: true,
        name: true,
        restricted: true,
        createdAt: true,
        updatedAt: true,
        permissions: grantsFor(viewer),
      },
    });
    if (!collection) {
      throw new ApiException(404, 'NOT_FOUND', 'This collection doesn’t exist, or it’s private.');
    }
    const access = collectionAccess(
      { userId: viewer.userId, role: viewer.role },
      collection,
      collection.permissions,
    );
    return { ...collection, access };
  }

  /** Throws unless the person has at least `minimum` access to the collection. */
  async require(viewer: Viewer, id: string, minimum: Access, message: string) {
    const collection = await this.open(viewer, id);
    if (!accessAtLeast(collection.access, minimum)) {
      throw new ApiException(403, 'ACCESS_REQUIRED', message);
    }
    return collection;
  }
}
