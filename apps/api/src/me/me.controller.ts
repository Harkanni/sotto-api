import { Body, Controller, Get, Inject, Module, Patch } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { forWorkspace } from '@sotto/db';
import { z } from 'zod';
import { csrfToken } from '../auth/csrf.js';
import { ROLES } from '../auth/roles.js';
import { ApiErrors } from '../common/errors.js';
import { type RequestAuth, Ctx } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import { readWorkspaceMeta } from '../workspaces/metadata.js';

export const RoleSchema = z.enum(ROLES).meta({ id: 'Role' });
export const HandednessSchema = z.enum(['right', 'left']).meta({ id: 'Handedness' });

export const Me = z
  .object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      /** Empty until the person sets it (magic-link sign-ups start without one). */
      name: z.string(),
      image: z.string().nullable(),
      handedness: HandednessSchema,
    }),
    /** The session's active workspace; null before onboarding. */
    workspace: z
      .object({
        id: z.string(),
        name: z.string(),
        role: RoleSchema,
        /**
         * Set once fictional sample content was loaded during onboarding: the sample
         * collections' keys ("product", "board"…) and their ids here. Null otherwise.
         */
        sample: z.object({ collections: z.record(z.string(), z.string()) }).nullable(),
      })
      .nullable(),
    /** Send as `X-CSRF-Token` on every write. Valid for this session only. */
    csrfToken: z.string(),
  })
  .meta({ id: 'Me' });

export type Me = z.infer<typeof Me>;

export const UpdateMe = z
  .object({
    name: z.string().trim().min(1, 'Enter your name.').max(80, 'Keep it under 80 characters.'),
    handedness: HandednessSchema,
  })
  .partial()
  .meta({ id: 'UpdateMe' });

function sampleOf(metadata: string | null): { collections: Record<string, string> } | null {
  const sample = readWorkspaceMeta(metadata).sample;
  return sample ? { collections: sample.collections } : null;
}

@ApiTags('me')
@ApiErrors()
@Controller('me')
export class MeController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get()
  @ApiOperation({ summary: 'The signed-in person, their active workspace and a CSRF token.' })
  @ApiOkResponse({ standardSchema: Me })
  async me(@Ctx() auth: RequestAuth): Promise<Me> {
    return this.load(auth);
  }

  @Patch()
  @ApiOperation({ summary: 'Change your name or which hand you use.' })
  @ApiOkResponse({ standardSchema: Me })
  async update(
    @Ctx() auth: RequestAuth,
    @Body({ schema: UpdateMe }) body: z.infer<typeof UpdateMe>,
  ): Promise<Me> {
    await this.prisma.client.user.update({
      where: { id: auth.user.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.handedness ? { handedness: body.handedness === 'left' ? 'LEFT' : 'RIGHT' } : {}),
      },
    });
    return this.load(auth);
  }

  private async load(auth: RequestAuth): Promise<Me> {
    const user = await this.prisma.client.user.findUniqueOrThrow({
      where: { id: auth.user.id },
      select: { id: true, email: true, name: true, image: true, handedness: true },
    });
    const workspace = auth.workspace
      ? await forWorkspace(this.prisma.client, auth.workspace.id).workspace.findFirst({
          select: { id: true, name: true, metadata: true },
        })
      : null;
    return {
      user: { ...user, handedness: user.handedness === 'LEFT' ? 'left' : 'right' },
      workspace:
        workspace && auth.workspace
          ? {
              id: workspace.id,
              name: workspace.name,
              role: auth.workspace.role,
              sample: sampleOf(workspace.metadata),
            }
          : null,
      csrfToken: csrfToken(this.config.AUTH_SECRET, auth.sessionId),
    };
  }
}

@Module({ controllers: [MeController] })
export class MeModule {}
