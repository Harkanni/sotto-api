import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@sotto/db';
import { fromNodeHeaders } from 'better-auth/node';
import { ApiException } from '../common/errors.js';
import type { ApiRequest } from '../common/request.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService } from '../core.module.js';
import { AUTH, type Auth } from './auth.js';
import { CSRF_HEADER, verifyCsrfToken } from './csrf.js';
import { atLeast } from './roles.js';

const PUBLIC = 'sotto:public';
const MIN_ROLE = 'sotto:min-role';

/** Open to anyone: health, status, sign-in methods, invite previews. */
export const Public = () => SetMetadata(PUBLIC, true);

/** Needs an active workspace in which the caller has at least this role. */
export const RequireRole = (role: Role) => SetMetadata(MIN_ROLE, role);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const NEEDS: Record<Role, string> = {
  owner: 'Only owners can do this.',
  admin: 'Only admins and owners can do this.',
  member: 'Viewers can’t make changes. Ask an admin to make you a member.',
  viewer: 'You’re not a member of this workspace.',
};

/**
 * One global guard, in a fixed order, so no route can forget a step:
 *   1. a Better Auth session (else 401)
 *   2. the session's active workspace and the caller's role in it (from the database, so a
 *      removed member loses access at once)
 *   3. on writes, the per-session CSRF token
 *   4. the minimum role a route asks for with `@RequireRole()`
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<ApiRequest>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw new ApiException(401, 'UNAUTHENTICATED', 'Sign in to continue.');

    const activeId = session.session.activeOrganizationId ?? null;
    const membership = activeId
      ? await this.prisma.client.membership.findUnique({
          where: { workspaceId_userId: { workspaceId: activeId, userId: session.user.id } },
          select: { role: true },
        })
      : null;

    req.auth = {
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        emailVerified: session.user.emailVerified,
        image: session.user.image ?? null,
      },
      sessionId: session.session.id,
      workspace: activeId && membership ? { id: activeId, role: membership.role } : null,
      ip: req.ip ?? null,
    };

    if (!SAFE_METHODS.has(req.method)) {
      if (!verifyCsrfToken(this.config.AUTH_SECRET, session.session.id, req.headers[CSRF_HEADER])) {
        throw new ApiException(
          403,
          'CSRF_TOKEN_INVALID',
          'This page is out of date. Reload it and try again.',
        );
      }
    }

    const minimum = this.reflector.getAllAndOverride<Role | undefined>(MIN_ROLE, targets);
    if (minimum) {
      const workspace = req.auth.workspace;
      if (!workspace) {
        throw new ApiException(403, 'NO_WORKSPACE', 'Create or join a workspace first.');
      }
      if (!atLeast(workspace.role, minimum)) {
        throw new ApiException(403, 'ROLE_REQUIRED', NEEDS[minimum]);
      }
    }
    return true;
  }
}
