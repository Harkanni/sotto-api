import type { Access, Role } from '@sotto/db';

/**
 * Roles inside a workspace (brief §2). Better Auth stores them as lowercase text; the database
 * enum keeps anything else out.
 *
 *   owner   everything, including other owners and deleting the workspace
 *   admin   members, invites, roles below owner, collections and their access, the audit log
 *   member  uses the library: creates collections, edits the open ones
 *   viewer  reads and asks; never changes anything
 */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const satisfies readonly Role[];

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** True when `role` is at least `minimum` (owner > admin > member > viewer). */
export function atLeast(role: Role, minimum: Role): boolean {
  return RANK[role] >= RANK[minimum];
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

const ACCESS_RANK: Record<Access, number> = { VIEW: 0, EDIT: 1, MANAGE: 2 };

export function higherAccess(a: Access | null, b: Access | null): Access | null {
  if (!a) return b;
  if (!b) return a;
  return ACCESS_RANK[a] >= ACCESS_RANK[b] ? a : b;
}

export function accessAtLeast(access: Access | null, minimum: Access): boolean {
  return access !== null && ACCESS_RANK[access] >= ACCESS_RANK[minimum];
}

/** A grant as stored: to one person or to everyone with a role. */
export interface Grant {
  userId: string | null;
  role: Role | null;
  access: Access;
}

/**
 * What someone can do with a collection. The SQL filters in the collections service apply the
 * same rules when listing; this decides single-collection actions and is unit-tested.
 *
 * - Owners and admins manage every collection.
 * - Viewers only ever view, whatever a grant says.
 * - An open collection: members edit, viewers view; a grant can raise that.
 * - A restricted collection: only a grant opens it.
 */
export function collectionAccess(
  viewer: { userId: string; role: Role },
  collection: { restricted: boolean },
  grants: readonly Grant[],
): Access | null {
  if (atLeast(viewer.role, 'admin')) return 'MANAGE';
  const granted = grants
    .filter((g) => g.userId === viewer.userId || g.role === viewer.role)
    .reduce<Access | null>((best, g) => higherAccess(best, g.access), null);
  const base: Access | null = collection.restricted
    ? null
    : viewer.role === 'viewer'
      ? 'VIEW'
      : 'EDIT';
  const access = higherAccess(base, granted);
  if (access && viewer.role === 'viewer') return 'VIEW';
  return access;
}
