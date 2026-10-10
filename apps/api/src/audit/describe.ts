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
      return typeof m.files === 'number' && m.files > 0
        ? `Deleted the collection ${quote(text('name'))} and moved its ${m.files === 1 ? 'file' : `${m.files} files`} to the trash`
        : `Deleted the collection ${quote(text('name'))}`;
    case 'collection.access_changed':
      return m.restricted
        ? `Restricted who can open ${quote(text('name'))}`
        : `Changed who can open ${quote(text('name'))}`;
    case 'audit.exported':
      return 'Exported the audit log';
    case 'onboarding.sample_loaded':
      return 'Loaded the sample content';
    case 'file.uploaded':
      return `Uploaded ${quote(text('name'))}`;
    case 'file.recorded':
      return `Recorded ${quote(text('name'))}`;
    case 'file.renamed':
      return `Renamed ${quote(text('from'))} to ${quote(text('to'))}`;
    case 'file.moved':
      return `Moved ${quote(text('name'))} ${text('to') ? `to ${quote(text('to'))}` : 'out of its collection'}`;
    case 'file.relabelled':
      return `Labelled ${quote(text('name'))} ${text('to')} (was ${text('from')})`;
    case 'file.trashed':
      return `Moved ${quote(text('name'))} to the trash`;
    case 'file.restored':
      return `Restored ${quote(text('name'))} from the trash`;
    case 'file.deleted':
      return `Deleted ${quote(text('name'))} for good`;
    case 'file.downloaded':
      return `Downloaded ${quote(text('name'))}`;
    case 'note.created':
      return `Wrote the note ${quote(text('name'))}`;
    case 'note.edited':
      return `Edited the note ${quote(text('name'))}`;
    case 'ai.policy_changed':
      return 'Changed the AI settings';
    case 'ai.model_toggled':
      return `${m.enabled ? 'Turned on' : 'Turned off'} the model ${text('model')} (${text('provider')})`;
    case 'ai.key_added':
      return `Added the ${text('provider')} key ${quote(text('name'))}`;
    case 'ai.key_replaced':
      return `Replaced the ${text('provider')} key ${quote(text('name'))}`;
    case 'ai.key_renamed':
      return `Renamed the key ${quote(text('from'))} to ${quote(text('to'))}`;
    case 'ai.key_removed':
      return `Removed the ${text('provider')} key ${quote(text('name'))}`;
    case 'billing.plan_changed':
      return `Changed the plan to ${text('to')}${m.test ? ' (test checkout)' : ''}`;
    case 'billing.payment_failed':
      return `A ${text('plan')} payment failed`;
    case 'billing.cancelled':
      return `Cancelled the ${text('plan')} plan`;
    case 'ask.asked':
      return 'Asked Sotto a question';
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
