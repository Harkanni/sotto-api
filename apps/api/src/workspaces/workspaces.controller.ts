import { randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Role, forWorkspace } from '@sotto/db';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AUTH, type Auth } from '../auth/auth.js';
import { RequireRole } from '../auth/auth.guard.js';
import { ApiErrors } from '../common/errors.js';
import { AuthHeaders, Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { PrismaService } from '../core.module.js';
import { RoleSchema } from '../me/me.controller.js';

export const WorkspaceSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Your role in it. */
    role: RoleSchema,
    /** True for the session's active workspace. */
    active: z.boolean(),
    members: z.number().int(),
  })
  .meta({ id: 'WorkspaceSummary' });

export type WorkspaceSummary = z.infer<typeof WorkspaceSummary>;

const WorkspaceName = z
  .string()
  .trim()
  .min(1, 'Name the workspace.')
  .max(60, 'Keep the name under 60 characters.');

export const CreateWorkspace = z.object({ name: WorkspaceName }).meta({ id: 'CreateWorkspace' });
export const UpdateWorkspace = z.object({ name: WorkspaceName }).meta({ id: 'UpdateWorkspace' });

export const IdParam = z.string().min(1).max(64);

/** Better Auth wants a unique slug; Sotto never shows it (the workspace comes from the session). */
export function slugFor(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'workspace'}-${randomBytes(4).toString('hex')}`;
}

@ApiTags('workspaces')
@ApiErrors()
@Controller()
export class WorkspacesController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('workspaces')
  @ApiOperation({ summary: 'The workspaces you belong to, with your role in each.' })
  @ApiOkResponse({ standardSchema: z.array(WorkspaceSummary) })
  async list(@Ctx() auth: RequestAuth): Promise<WorkspaceSummary[]> {
    const memberships = await this.prisma.client.membership.findMany({
      where: { userId: auth.user.id },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        workspace: { select: { id: true, name: true, _count: { select: { memberships: true } } } },
      },
    });
    return memberships.map(({ role, workspace }) => ({
      id: workspace.id,
      name: workspace.name,
      role,
      active: workspace.id === auth.workspace?.id,
      members: workspace._count.memberships,
    }));
  }

  @Post('workspaces')
  @ApiOperation({ summary: 'Create a workspace. You become its owner and it becomes active.' })
  @ApiOkResponse({ standardSchema: WorkspaceSummary })
  @HttpCode(201)
  async create(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Body({ schema: CreateWorkspace }) body: z.infer<typeof CreateWorkspace>,
  ): Promise<WorkspaceSummary> {
    const created = await this.auth.api.createOrganization({
      body: { name: body.name, slug: slugFor(body.name) },
      headers,
    });
    if (!created) throw new Error('Workspace was not created');
    await this.audit.record(created.id, auth, {
      action: 'workspace.created',
      target: { type: 'workspace', id: created.id },
      meta: { name: body.name },
    });
    return { id: created.id, name: created.name, role: 'owner', active: true, members: 1 };
  }

  @Post('workspaces/:id/activate')
  @ApiOperation({ summary: 'Switch the session to another of your workspaces.' })
  @ApiOkResponse({ standardSchema: WorkspaceSummary })
  @HttpCode(200)
  async activate(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<WorkspaceSummary> {
    await this.auth.api.setActiveOrganization({ body: { organizationId: id }, headers });
    const membership = await this.prisma.client.membership.findUniqueOrThrow({
      where: { workspaceId_userId: { workspaceId: id, userId: auth.user.id } },
      select: {
        role: true,
        workspace: { select: { name: true, _count: { select: { memberships: true } } } },
      },
    });
    return {
      id,
      name: membership.workspace.name,
      role: membership.role as Role,
      active: true,
      members: membership.workspace._count.memberships,
    };
  }

  @Patch('workspace')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Rename the active workspace (admins and owners).' })
  @ApiOkResponse({ standardSchema: WorkspaceSummary })
  async update(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Body({ schema: UpdateWorkspace }) body: z.infer<typeof UpdateWorkspace>,
  ): Promise<WorkspaceSummary> {
    const workspace = workspaceOf(auth);
    const db = forWorkspace(this.prisma.client, workspace.id);
    const before = await db.workspace.findFirstOrThrow({ select: { name: true } });
    await this.auth.api.updateOrganization({
      body: { organizationId: workspace.id, data: { name: body.name } },
      headers,
    });
    if (before.name !== body.name) {
      await this.audit.record(workspace.id, auth, {
        action: 'workspace.renamed',
        target: { type: 'workspace', id: workspace.id },
        meta: { from: before.name, to: body.name },
      });
    }
    const members = await db.membership.count();
    return { id: workspace.id, name: body.name, role: workspace.role, active: true, members };
  }
}

@Module({ controllers: [WorkspacesController] })
export class WorkspacesModule {}
