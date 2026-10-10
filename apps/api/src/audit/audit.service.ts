import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { type Prisma, forWorkspace } from '@sotto/db';
import type { RequestAuth } from '../common/request.js';
import { PrismaService } from '../core.module.js';

/**
 * Everything the audit log records (brief §4: settings changes, members, exports, deletes;
 * uploads, views and questions join in Phases 4–5). The meta of each entry holds names and
 * roles only, never content: a question is recorded as asked, never what it said.
 */
export const AUDIT_ACTIONS = [
  'workspace.created',
  'workspace.renamed',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'invite.sent',
  'invite.resent',
  'invite.revoked',
  'collection.created',
  'collection.updated',
  'collection.deleted',
  'collection.access_changed',
  'audit.exported',
  'onboarding.sample_loaded',
  'file.uploaded',
  'file.recorded',
  'file.renamed',
  'file.moved',
  'file.relabelled',
  'file.trashed',
  'file.restored',
  'file.deleted',
  'file.downloaded',
  'note.created',
  'note.edited',
  'ask.asked',
  'ai.policy_changed',
  'ai.model_toggled',
  'ai.key_added',
  'ai.key_replaced',
  'ai.key_renamed',
  'ai.key_removed',
  'billing.plan_changed',
  'billing.payment_failed',
  'billing.cancelled',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditTarget =
  | 'workspace'
  | 'member'
  | 'invite'
  | 'collection'
  | 'audit'
  | 'file'
  | 'conversation'
  | 'subscription';

export interface AuditEntry {
  action: AuditAction;
  target: { type: AuditTarget; id?: string | null };
  /** Small, non-sensitive details shown in the log: names, emails, roles, before and after. */
  meta?: Prisma.InputJsonObject;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger('audit');

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Writes one entry in the caller's workspace. A failure is logged and swallowed: the change it
   * describes has already happened, and refusing the response wouldn't undo it.
   */
  async record(
    workspaceId: string,
    by: Pick<RequestAuth, 'ip'> & { user: { id: string } },
    entry: AuditEntry,
  ): Promise<void> {
    try {
      await forWorkspace(this.prisma.client, workspaceId).auditLog.create({
        data: {
          workspaceId,
          actorId: by.user.id,
          action: entry.action,
          targetType: entry.target.type,
          targetId: entry.target.id ?? null,
          ip: by.ip,
          ...(entry.meta ? { meta: entry.meta } : {}),
        },
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      this.log.error(
        `could not record ${entry.action} (${typeof code === 'string' ? code : 'error'})`,
      );
    }
  }
  /** An entry with no person behind it (a payment provider's webhook): shown as "Sotto". */
  async recordSystem(workspaceId: string, entry: AuditEntry): Promise<void> {
    try {
      await forWorkspace(this.prisma.client, workspaceId).auditLog.create({
        data: {
          workspaceId,
          actorId: null,
          action: entry.action,
          targetType: entry.target.type,
          targetId: entry.target.id ?? null,
          ip: null,
          ...(entry.meta ? { meta: entry.meta } : {}),
        },
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      this.log.error(
        `could not record ${entry.action} (${typeof code === 'string' ? code : 'error'})`,
      );
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
