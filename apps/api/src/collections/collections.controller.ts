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
  Put,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type Access, Prisma, tenantTransaction } from '@sotto/db';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { RequireRole } from '../auth/auth.guard.js';
import { collectionAccess } from '../auth/roles.js';
import { ApiErrors, ApiException } from '../common/errors.js';
import { Ctx, type RequestAuth, workspaceOf } from '../common/request.js';
import { RoleSchema } from '../me/me.controller.js';
import { IdParam } from '../workspaces/workspaces.controller.js';
import { CollectionsService, type Viewer, grantsFor, visibleTo } from './collections.service.js';

export const AccessSchema = z.enum(['view', 'edit', 'manage']).meta({ id: 'Access' });
type AccessWord = z.infer<typeof AccessSchema>;

const toWord = (access: Access): AccessWord => access.toLowerCase() as AccessWord;
const fromWord = (word: AccessWord): Access => word.toUpperCase() as Access;

export const CollectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Only people and roles with a grant (and owners and admins) can see it. */
    restricted: z.boolean(),
    /** What you can do: view, edit (add and change files), manage (rename, delete). */
    access: AccessSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Collection' });

type CollectionOut = z.infer<typeof CollectionSchema>;

const CollectionName = z
  .string()
  .trim()
  .min(1, 'Name the collection.')
  .max(60, 'Keep the name under 60 characters.');

export const CreateCollection = z
  .object({ name: CollectionName, restricted: z.boolean().optional() })
  .meta({ id: 'CreateCollection' });

export const UpdateCollection = z.object({ name: CollectionName }).meta({ id: 'UpdateCollection' });

export const GrantSchema = z
  .object({
    /** A person (a member of this workspace)… */
    userId: z.string().nullable(),
    /** …or everyone with a role. Exactly one of the two. */
    role: RoleSchema.nullable(),
    access: AccessSchema,
    /** The person's name and email, for display (null for role grants). */
    user: z.object({ name: z.string(), email: z.string() }).nullable(),
  })
  .meta({ id: 'Grant' });

export const CollectionPermissions = z
  .object({ restricted: z.boolean(), grants: z.array(GrantSchema) })
  .meta({ id: 'CollectionPermissions' });

export const PutPermissions = z
  .object({
    restricted: z.boolean(),
    grants: z
      .array(
        z
          .object({
            userId: z.string().min(1).optional(),
            role: RoleSchema.optional(),
            access: AccessSchema,
          })
          .refine((g) => Boolean(g.userId) !== Boolean(g.role), {
            message: 'Each grant names one person or one role.',
          }),
      )
      .max(200),
  })
  .meta({ id: 'PutPermissions' });

function present(
  c: { id: string; name: string; restricted: boolean; createdAt: Date; updatedAt: Date },
  access: Access,
): CollectionOut {
  return {
    id: c.id,
    name: c.name,
    restricted: c.restricted,
    access: toWord(access),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function viewerOf(auth: RequestAuth): Viewer {
  const workspace = workspaceOf(auth);
  return { userId: auth.user.id, role: workspace.role, workspaceId: workspace.id };
}

@ApiTags('collections')
@ApiErrors()
@Controller('collections')
export class CollectionsController {
  constructor(
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get()
  @RequireRole('viewer')
  @ApiOperation({ summary: 'The collections you can see, with what you can do in each.' })
  @ApiOkResponse({ standardSchema: z.array(CollectionSchema) })
  async list(@Ctx() auth: RequestAuth): Promise<CollectionOut[]> {
    const viewer = viewerOf(auth);
    const rows = await this.collections.db(viewer.workspaceId).collection.findMany({
      where: visibleTo(viewer),
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        name: true,
        restricted: true,
        createdAt: true,
        updatedAt: true,
        permissions: grantsFor(viewer),
      },
    });
    return rows.flatMap((c) => {
      const access = collectionAccess(viewer, c, c.permissions);
      return access ? [present(c, access)] : [];
    });
  }

  @Post()
  @RequireRole('member')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a collection. You manage it; restricted ones start private.' })
  @ApiOkResponse({ standardSchema: CollectionSchema })
  async create(
    @Ctx() auth: RequestAuth,
    @Body({ schema: CreateCollection }) body: z.infer<typeof CreateCollection>,
  ): Promise<CollectionOut> {
    const viewer = viewerOf(auth);
    const db = this.collections.db(viewer.workspaceId);
    const created = await db.collection.create({
      data: {
        workspaceId: viewer.workspaceId,
        name: body.name,
        restricted: body.restricted ?? false,
        // The creator keeps Manage even if their role changes later.
        permissions: {
          create: { workspaceId: viewer.workspaceId, userId: viewer.userId, access: 'MANAGE' },
        },
      },
    });
    await this.audit.record(viewer.workspaceId, auth, {
      action: 'collection.created',
      target: { type: 'collection', id: created.id },
      meta: { name: created.name, restricted: created.restricted },
    });
    return present(created, 'MANAGE');
  }

  @Patch(':id')
  @RequireRole('member')
  @ApiOperation({ summary: 'Rename a collection (needs Edit access).' })
  @ApiOkResponse({ standardSchema: CollectionSchema })
  async update(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: UpdateCollection }) body: z.infer<typeof UpdateCollection>,
  ): Promise<CollectionOut> {
    const viewer = viewerOf(auth);
    const before = await this.collections.require(
      viewer,
      id,
      'EDIT',
      'You can view this collection but not rename it.',
    );
    const updated = await this.collections
      .db(viewer.workspaceId)
      .collection.update({ where: { id }, data: { name: body.name } });
    if (before.name !== body.name) {
      await this.audit.record(viewer.workspaceId, auth, {
        action: 'collection.updated',
        target: { type: 'collection', id },
        meta: { from: before.name, to: body.name },
      });
    }
    return present(updated, before.access!);
  }

  @Delete(':id')
  @RequireRole('member')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a collection (needs Manage access).' })
  @ApiNoContentResponse()
  async remove(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<void> {
    const viewer = viewerOf(auth);
    const collection = await this.collections.require(
      viewer,
      id,
      'MANAGE',
      'Only people who manage this collection can delete it.',
    );
    await this.collections.db(viewer.workspaceId).collection.delete({ where: { id } });
    await this.audit.record(viewer.workspaceId, auth, {
      action: 'collection.deleted',
      target: { type: 'collection', id },
      meta: { name: collection.name },
    });
  }

  @Get(':id/permissions')
  @RequireRole('admin')
  @ApiOperation({ summary: 'Who can open a collection (admins and owners).' })
  @ApiOkResponse({ standardSchema: CollectionPermissions })
  async permissions(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
  ): Promise<z.infer<typeof CollectionPermissions>> {
    const viewer = viewerOf(auth);
    const collection = await this.collections.db(viewer.workspaceId).collection.findUnique({
      where: { id },
      select: {
        restricted: true,
        permissions: {
          orderBy: { createdAt: 'asc' },
          select: {
            userId: true,
            role: true,
            access: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
    });
    if (!collection) throw new ApiException(404, 'NOT_FOUND', 'This collection doesn’t exist.');
    return {
      restricted: collection.restricted,
      grants: collection.permissions.map((g) => ({
        userId: g.userId,
        role: g.role,
        access: toWord(g.access),
        user: g.user,
      })),
    };
  }

  @Put(':id/permissions')
  @RequireRole('admin')
  @ApiOperation({
    summary:
      'Replace who can open a collection: restricted or open, and the grants (admins and owners).',
  })
  @ApiOkResponse({ standardSchema: CollectionPermissions })
  async setPermissions(
    @Ctx() auth: RequestAuth,
    @Param('id', { schema: IdParam }) id: string,
    @Body({ schema: PutPermissions }) body: z.infer<typeof PutPermissions>,
  ): Promise<z.infer<typeof CollectionPermissions>> {
    const viewer = viewerOf(auth);
    const db = this.collections.db(viewer.workspaceId);
    const collection = await db.collection.findUnique({ where: { id }, select: { name: true } });
    if (!collection) throw new ApiException(404, 'NOT_FOUND', 'This collection doesn’t exist.');

    const people = [...new Set(body.grants.flatMap((g) => (g.userId ? [g.userId] : [])))];
    const roles = body.grants.flatMap((g) => (g.role ? [g.role] : []));
    if (
      people.length + roles.length !== body.grants.length ||
      new Set(roles).size !== roles.length
    ) {
      throw new ApiException(400, 'INVALID_INPUT', 'Each person or role can appear only once.');
    }
    const members = await db.membership.count({ where: { userId: { in: people } } });
    if (members !== people.length) {
      throw new ApiException(
        400,
        'INVALID_INPUT',
        'Grants can only name people in this workspace.',
      );
    }

    // One transaction on the workspace-scoped client: the old grants go, the new ones arrive,
    // and nobody sees a half-written set.
    await tenantTransaction(db, async (tx) => {
      await tx.collectionPermission.deleteMany({
        where: { collectionId: id, workspaceId: viewer.workspaceId },
      });
      if (body.grants.length) {
        await tx.collectionPermission.createMany({
          data: body.grants.map((g) => ({
            workspaceId: viewer.workspaceId,
            collectionId: id,
            userId: g.userId ?? null,
            role: g.role ?? null,
            access: fromWord(g.access),
          })),
        });
      }
      await tx.collection.update({
        where: { id, workspaceId: viewer.workspaceId },
        data: { restricted: body.restricted },
      });
    });

    await this.audit.record(viewer.workspaceId, auth, {
      action: 'collection.access_changed',
      target: { type: 'collection', id },
      meta: {
        name: collection.name,
        restricted: body.restricted,
        people: people.length,
        roles: roles as Prisma.InputJsonArray,
      },
    });
    return this.permissions(auth, id);
  }
}

@Module({
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
