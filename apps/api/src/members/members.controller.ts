import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type InviteStatus, type Role, forWorkspace } from '@sotto/db';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { AUTH, type Auth } from '../auth/auth.js';
import { Public, RequireRole } from '../auth/auth.guard.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { AuthHeaders, Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { PrismaService } from '../core.module.js';
import { RoleSchema } from '../me/me.controller.js';
import { IdParam, WorkspaceSummary } from '../workspaces/workspaces.controller.js';

const Person = z.object({ name: z.string(), email: z.string() });

export const Member = z
  .object({
    /** The membership's id (what PATCH and DELETE /members/:id take). */
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: RoleSchema,
    joinedAt: z.iso.datetime(),
    /** True for the person asking. */
    you: z.boolean(),
  })
  .meta({ id: 'Member' });

export const PendingInvite = z
  .object({
    /** Also the secret in the invite link, so admins can copy it. */
    id: z.string(),
    email: z.string(),
    role: RoleSchema,
    invitedBy: Person.nullable(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    /** Past its expiry: resending gives it another week. */
    expired: z.boolean(),
  })
  .meta({ id: 'PendingInvite' });

export const MemberList = z
  .object({ members: z.array(Member), invites: z.array(PendingInvite) })
  .meta({ id: 'MemberList' });

export const UpdateMember = z.object({ role: RoleSchema }).meta({ id: 'UpdateMember' });

export const CreateInvite = z
  .object({
    email: z.email('Enter an email address.').max(254),
    role: RoleSchema,
    /** Send the existing invite again (same link, another week) instead of a new one. */
    resend: z.boolean().optional(),
  })
  .meta({ id: 'CreateInvite' });

export const InviteState = z
  .enum(['pending', 'accepted', 'declined', 'revoked', 'expired'])
  .meta({ id: 'InviteState' });

/** What the invite screen shows before someone accepts. Only the token holder can read it. */
export const InvitePreview = z
  .object({
    workspace: z.object({ name: z.string() }),
    invitedBy: Person.nullable(),
    /** The address it was sent to: sign in with this one to accept. */
    email: z.string(),
    role: RoleSchema,
    state: InviteState,
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'InvitePreview' });

type Member = z.infer<typeof Member>;
type PendingInvite = z.infer<typeof PendingInvite>;

export function inviteState(status: InviteStatus, expiresAt: Date, now = new Date()) {
  if (status === 'accepted') return 'accepted' as const;
  if (status === 'rejected') return 'declined' as const;
  if (status === 'canceled') return 'revoked' as const;
  return expiresAt <= now ? ('expired' as const) : ('pending' as const);
}

const ROLE_WORD: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

@ApiTags('members')
@ApiErrors()
@Controller()
export class MembersController {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('members')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Members of the active workspace and the invites still open.' })
  @ApiOkResponse({ standardSchema: MemberList })
  async list(@Ctx() auth: RequestAuth): Promise<z.infer<typeof MemberList>> {
    const db = forWorkspace(this.prisma.client, workspaceOf(auth).id);
    const [memberships, invites] = await Promise.all([
      db.membership.findMany({
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          role: true,
          createdAt: true,
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      }),
      db.invite.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          role: true,
          createdAt: true,
          expiresAt: true,
          inviter: { select: { name: true, email: true } },
        },
      }),
    ]);
    const now = new Date();
    return {
      members: memberships.map((m): Member => ({
        id: m.id,
        userId: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        role: m.role,
        joinedAt: m.createdAt.toISOString(),
        you: m.user.id === auth.user.id,
      })),
      invites: invites.map((i): PendingInvite => ({
        id: i.id,
        email: i.email,
        role: i.role,
        invitedBy: i.inviter,
        createdAt: i.createdAt.toISOString(),
        expiresAt: i.expiresAt.toISOString(),
        expired: i.expiresAt <= now,
      })),
    };
  }

  @Patch('members/:id')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Change someone’s role. Only owners can make or unmake owners.' })
  @ApiOkResponse({ standardSchema: Member })
  async updateRole(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateMember }) body: z.infer<typeof UpdateMember>,
  ): Promise<Member> {
    const workspace = workspaceOf(auth);
    const db = forWorkspace(this.prisma.client, workspace.id);
    const target = await db.membership.findUnique({
      where: { id },
      select: { role: true, user: { select: { id: true, name: true, email: true, image: true } } },
    });
    if (!target) throw new ApiException(404, 'NOT_FOUND', 'This person isn’t in the workspace.');

    await this.auth.api.updateMemberRole({
      body: { memberId: id, role: body.role, organizationId: workspace.id },
      headers,
    });
    if (target.role !== body.role) {
      await this.audit.record(workspace.id, auth, {
        action: 'member.role_changed',
        target: { type: 'member', id: target.user.id },
        meta: {
          name: target.user.name || target.user.email,
          email: target.user.email,
          from: ROLE_WORD[target.role],
          to: ROLE_WORD[body.role],
        },
      });
    }
    const updated = await db.membership.findUniqueOrThrow({
      where: { id },
      select: { role: true, createdAt: true },
    });
    return {
      id,
      userId: target.user.id,
      name: target.user.name,
      email: target.user.email,
      image: target.user.image,
      role: updated.role,
      joinedAt: updated.createdAt.toISOString(),
      you: target.user.id === auth.user.id,
    };
  }

  @Delete('members/:id')
  @RequireRole('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove someone from the workspace. Their own access grants go too.' })
  @ApiNoContentResponse()
  async remove(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<void> {
    const workspace = workspaceOf(auth);
    const db = forWorkspace(this.prisma.client, workspace.id);
    const target = await db.membership.findUnique({
      where: { id },
      select: { role: true, user: { select: { id: true, name: true, email: true } } },
    });
    if (!target) throw new ApiException(404, 'NOT_FOUND', 'This person isn’t in the workspace.');
    if (target.role === 'owner' && workspace.role !== 'owner') {
      throw new ApiException(403, 'ROLE_REQUIRED', 'Only owners can remove an owner.');
    }

    await this.auth.api.removeMember({
      body: { memberIdOrEmail: id, organizationId: workspace.id },
      headers,
    });
    // Their personal grants would quietly come back if they were invited again.
    await db.collectionPermission.deleteMany({ where: { userId: target.user.id } });
    // Sessions still pointing here fall back to "no workspace" instead of a dead one.
    await this.prisma.client.session.updateMany({
      where: { userId: target.user.id, activeWorkspaceId: workspace.id },
      data: { activeWorkspaceId: null },
    });
    await this.audit.record(workspace.id, auth, {
      action: 'member.removed',
      target: { type: 'member', id: target.user.id },
      meta: {
        name: target.user.name || target.user.email,
        email: target.user.email,
        role: ROLE_WORD[target.role],
      },
    });
  }

  @Post('invites')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Invite someone by email. With `resend`, sends the open invite again.' })
  @ApiOkResponse({ standardSchema: PendingInvite })
  @HttpCode(201)
  async invite(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Body({ schema: CreateInvite }) body: z.infer<typeof CreateInvite>,
  ): Promise<PendingInvite> {
    const workspace = workspaceOf(auth);
    const email = body.email.trim().toLowerCase();
    const created = await this.auth.api.createInvitation({
      body: { email, role: body.role, organizationId: workspace.id, resend: body.resend ?? false },
      headers,
    });
    await this.audit.record(workspace.id, auth, {
      action: body.resend ? 'invite.resent' : 'invite.sent',
      target: { type: 'invite', id: created.id },
      meta: { email, role: ROLE_WORD[created.role as Role] ?? created.role },
    });
    return {
      id: created.id,
      email: created.email,
      role: created.role as Role,
      invitedBy: { name: auth.user.name, email: auth.user.email },
      createdAt: new Date(created.createdAt ?? Date.now()).toISOString(),
      expiresAt: new Date(created.expiresAt).toISOString(),
      expired: false,
    };
  }

  @Delete('invites/:id')
  @RequireRole('admin')
  @HttpCode(204)
  @ApiOperation({ summary: 'Withdraw an invite. Its link stops working.' })
  @ApiNoContentResponse()
  async revoke(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<void> {
    const workspace = workspaceOf(auth);
    const invite = await forWorkspace(this.prisma.client, workspace.id).invite.findUnique({
      where: { id },
      select: { email: true, status: true },
    });
    if (!invite) throw new ApiException(404, 'NOT_FOUND', 'This invite doesn’t exist.');
    if (invite.status !== 'pending') return;
    await this.auth.api.cancelInvitation({ body: { invitationId: id }, headers });
    await this.audit.record(workspace.id, auth, {
      action: 'invite.revoked',
      target: { type: 'invite', id },
      meta: { email: invite.email },
    });
  }

  @Get('invites/:id')
  @Public()
  @ApiOperation({
    summary:
      'What an invite link offers, before signing in to accept it (the id is the link’s token).',
  })
  @ApiOkResponse({ standardSchema: InvitePreview })
  async preview(
    @Param('id', { schema: IdParam }) token: string,
  ): Promise<z.infer<typeof InvitePreview>> {
    // No workspace scope: the token itself is the permission to read this one row.
    const invite = await this.prisma.client.invite.findUnique({
      where: { id: token },
      select: {
        email: true,
        role: true,
        status: true,
        expiresAt: true,
        workspace: { select: { name: true } },
        inviter: { select: { name: true, email: true } },
      },
    });
    if (!invite) {
      throw new ApiException(
        404,
        'INVITE_NOT_FOUND',
        'This invite link isn’t valid. Ask for a new one.',
      );
    }
    return {
      workspace: invite.workspace,
      invitedBy: invite.inviter,
      email: invite.email,
      role: invite.role,
      state: inviteState(invite.status, invite.expiresAt),
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  @Post('invites/:id/accept')
  @ApiOperation({ summary: 'Join the workspace an invite is for. It becomes your active one.' })
  @ApiOkResponse({ standardSchema: WorkspaceSummary })
  @HttpCode(200)
  async accept(
    @Ctx() auth: RequestAuth,
    @AuthHeaders() headers: Headers,
    @Param('id', { schema: IdParam }) token: string,
  ): Promise<z.infer<typeof WorkspaceSummary>> {
    const result = await this.auth.api.acceptInvitation({
      body: { invitationId: token },
      headers,
    });
    const workspaceId = result?.member.organizationId;
    if (!workspaceId) throw new ApiException(400, 'INVITE_NOT_FOUND', 'This invite can’t be used.');
    const role = result.member.role as Role;
    await this.audit.record(workspaceId, auth, {
      action: 'member.joined',
      target: { type: 'member', id: auth.user.id },
      meta: {
        name: auth.user.name || auth.user.email,
        email: auth.user.email,
        role: ROLE_WORD[role],
      },
    });
    const workspace = await forWorkspace(
      this.prisma.client,
      workspaceId,
    ).workspace.findFirstOrThrow({
      select: {
        id: true,
        name: true,
        meetingBots: true,
        _count: { select: { memberships: true } },
      },
    });
    return {
      id: workspace.id,
      name: workspace.name,
      role,
      active: true,
      members: workspace._count.memberships,
      meetingBots: workspace.meetingBots,
    };
  }
}

@Module({ controllers: [MembersController] })
export class MembersModule {}
