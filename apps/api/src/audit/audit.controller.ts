import { Controller, Get, Header, Inject, Module, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { type AuditLog, Prisma, forWorkspace } from '@sotto/db';
import { z } from 'zod';
import { RequireRole } from '../auth/auth.guard.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { PrismaService } from '../core.module.js';
import { AUDIT_ACTIONS, AuditService } from './audit.service.js';
import { describeEntry } from './describe.js';

export const AuditQuery = z
  .object({
    /** Inclusive start, ISO date or date-time. */
    from: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
    /** Exclusive end, ISO date or date-time. */
    to: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
    /** A user id. */
    actor: z.string().min(1).max(64).optional(),
    /** A full action ("member.removed") or a group ("member"). */
    action: z
      .string()
      .regex(/^[a-z_]+(\.[a-z_]+)?$/, 'Use an action like member.removed, or a group like member.')
      .optional(),
    /** The `nextCursor` of the previous page. */
    cursor: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .meta({ id: 'AuditQuery' });

type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditEntrySchema = z
  .object({
    id: z.string(),
    at: z.iso.datetime(),
    action: z.enum(AUDIT_ACTIONS),
    /** One readable line, e.g. "Changed Tunde Bakare’s role from Member to Admin". */
    summary: z.string(),
    actor: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
    target: z.object({ type: z.string(), id: z.string().nullable() }),
    ip: z.string().nullable(),
  })
  .meta({ id: 'AuditEntry' });

export const AuditPage = z
  .object({ entries: z.array(AuditEntrySchema), nextCursor: z.string().nullable() })
  .meta({ id: 'AuditPage' });

type Row = AuditLog & { actor: { id: string; name: string; email: string } | null };

/** A byte-order mark, written as an escape so the source stays plain text. */
const BOM = '\uFEFF';

/** Rows past this many are left out of a CSV export, so one request stays bounded. */
export const CSV_LIMIT = 10_000;

function startOf(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function where(query: AuditQuery): Prisma.AuditLogWhereInput {
  const from = startOf(query.from);
  const to = startOf(query.to);
  if (from && Number.isNaN(from.valueOf()))
    throw new ApiException(400, 'INVALID_INPUT', 'from isn’t a date.');
  if (to && Number.isNaN(to.valueOf()))
    throw new ApiException(400, 'INVALID_INPUT', 'to isn’t a date.');
  return {
    ...(from || to ? { at: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
    ...(query.actor ? { actorId: query.actor } : {}),
    ...(query.action
      ? query.action.includes('.')
        ? { action: query.action }
        : { action: { startsWith: `${query.action}.` } }
      : {}),
  };
}

function present(row: Row): z.infer<typeof AuditEntrySchema> {
  return {
    id: row.id,
    at: row.at.toISOString(),
    action: row.action as z.infer<typeof AuditEntrySchema>['action'],
    summary: describeEntry(row.action, row.meta),
    actor: row.actor,
    target: { type: row.targetType, id: row.targetId },
    ip: row.ip,
  };
}

/** A CSV cell: quoted, quotes doubled, and formula starters defused for spreadsheet apps. */
export function csvCell(value: string | null | undefined): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

@ApiTags('audit')
@ApiErrors()
@Controller()
export class AuditController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private db(auth: RequestAuth) {
    return forWorkspace(this.prisma.client, workspaceOf(auth).id);
  }

  @Get('audit')
  @RequireRole('admin')
  @ApiOperation({ summary: 'The audit log, newest first, filtered and paged (admins and owners).' })
  @ApiOkResponse({ standardSchema: AuditPage })
  async list(
    @Ctx() auth: RequestAuth,
    @Query({ schema: AuditQuery }) query: AuditQuery,
  ): Promise<z.infer<typeof AuditPage>> {
    const rows = await this.db(auth).auditLog.findMany({
      where: where(query),
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { actor: { select: { id: true, name: true, email: true } } },
    });
    const page = rows.slice(0, query.limit);
    return {
      entries: page.map(present),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  @Get('audit.csv')
  @RequireRole('admin')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'The same entries as a CSV file (up to 10,000 rows). The export is logged.',
  })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async csv(
    @Ctx() auth: RequestAuth,
    @Query({ schema: AuditQuery.omit({ cursor: true, limit: true }) }) query: AuditQuery,
    @Res({ passthrough: true }) res: { setHeader(name: string, value: string): unknown },
  ): Promise<string> {
    const workspace = workspaceOf(auth);
    const rows = await this.db(auth).auditLog.findMany({
      where: where(query),
      orderBy: [{ at: 'desc' }, { id: 'desc' }],
      take: CSV_LIMIT,
      include: { actor: { select: { id: true, name: true, email: true } } },
    });
    await this.audit.record(workspace.id, auth, {
      action: 'audit.exported',
      target: { type: 'audit' },
      meta: { rows: rows.length },
    });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="sotto-audit-${day}.csv"`);
    const header = [
      'Time (UTC)',
      'Person',
      'Email',
      'Action',
      'What happened',
      'Target',
      'IP address',
    ];
    const lines = rows.map((row) =>
      [
        row.at.toISOString(),
        row.actor?.name || (row.actorId ? '' : 'Deleted account'),
        row.actor?.email ?? '',
        row.action,
        describeEntry(row.action, row.meta),
        row.targetType,
        row.ip ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
    // A byte-order mark so spreadsheet apps read the file as UTF-8.
    return `${BOM}${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
  }
}

@Module({ controllers: [AuditController] })
export class AuditApiModule {}
