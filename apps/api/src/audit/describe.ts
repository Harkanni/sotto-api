import type { Prisma } from '@sotto/db';

/**
 * One plain sentence per audit entry, used by the audit screen and the CSV export alike. The
 * actor is shown separately, so sentences start with the verb ("Invited …"). Only the names and
 * roles kept in `meta` appear; never content.
 */
export function describeEntry(action: string, meta: Prisma.JsonValue | null): string {
  const m = (meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}) as Record<
    string,
    unknown
  >;
  const text = (key: string) => (typeof m[key] === 'string' ? (m[key] as string) : '');
  const who = text('name') || text('email') || 'someone';

  switch (action) {
    case 'workspace.created':
      return `Created the workspace ${quote(text('name'))}`;
    case 'workspace.renamed':
      return `Renamed the workspace from ${quote(text('from'))} to ${quote(text('to'))}`;
    case 'member.joined':
      return `Joined as ${article(text('role'))}`;
    case 'member.role_changed':
      return `Changed ${possessive(who)} role from ${text('from')} to ${text('to')}`;
    case 'member.removed':
      return `Removed ${who} from the workspace`;
    case 'invite.sent':
      return `Invited ${text('email')} as ${article(text('role'))}`;
    case 'invite.resent':
      return `Resent the invite to ${text('email')}`;
    case 'invite.revoked':
      return `Withdrew the invite to ${text('email')}`;
    case 'collection.created':
      return `Created the ${m.restricted ? 'restricted ' : ''}collection ${quote(text('name'))}`;
    case 'collection.updated':
      return `Renamed the collection ${quote(text('from'))} to ${quote(text('to'))}`;
    case 'collection.deleted':
      return `Deleted the collection ${quote(text('name'))}`;
    case 'collection.access_changed':
      return m.restricted
        ? `Restricted who can open ${quote(text('name'))}`
        : `Changed who can open ${quote(text('name'))}`;
    case 'audit.exported':
      return 'Exported the audit log';
    case 'onboarding.sample_loaded':
      return 'Loaded the sample content';
    default:
      return action;
  }
}

function quote(value: string): string {
  return `“${value}”`;
}

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}’` : `${name}’s`;
}

function article(role: string): string {
  if (!role) return 'a member';
  const lower = role.toLowerCase();
  return /^[aeiou]/.test(lower) ? `an ${lower}` : `a ${lower}`;
}
