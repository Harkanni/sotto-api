import { passkey } from '@better-auth/passkey';
import type { PrismaClient } from '@sotto/db';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { magicLink, organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from 'better-auth/plugins/organization/access';
import { Logger } from '@nestjs/common';
import type { ApiConfig } from '../config.js';
import { MailNotConfiguredError, type Mailer } from '../mail/mailer.js';
import { MAGIC_LINK_EXPIRES_IN_SECONDS, inviteEmail, magicLinkEmail } from '../mail/templates.js';
import type { RateLimitStore } from './rate-limit.js';
import { isRole } from './roles.js';

export const AUTH_BASE_PATH = '/api/auth';

/** Invites stay open for a week; the email names the day they expire. */
export const INVITE_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/** Sessions last 30 days and roll forward once a day while someone keeps using Sotto. */
const SESSION_DAYS = 30;

const ac = createAccessControl(defaultStatements);

/** Better Auth's built-in checks for its organization actions. Viewers can do none of them. */
const roles = {
  owner: ownerAc,
  admin: adminAc,
  member: memberAc,
  viewer: ac.newRole({ organization: [], member: [], invitation: [], team: [], ac: ['read'] }),
};

/** The URL in an invite email. The invite's id is the secret; the web shows /invite/:token. */
export function inviteUrl(appUrl: string, inviteId: string): string {
  return new URL(`/invite/${encodeURIComponent(inviteId)}`, appUrl).toString();
}

export interface AuthDeps {
  config: ApiConfig;
  prisma: PrismaClient;
  mailer: Mailer;
  rateLimitStore?: RateLimitStore;
}

/** Turns a mail failure into an answer the sign-in screen can show. */
async function sendOrExplain(send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    if (error instanceof MailNotConfiguredError) {
      throw new APIError('SERVICE_UNAVAILABLE', {
        code: 'MAIL_NOT_CONFIGURED',
        message: 'Email isn’t set up on this server yet.',
      });
    }
    throw new APIError('BAD_GATEWAY', {
      code: 'MAIL_SEND_FAILED',
      message: 'The email couldn’t be sent. Try again in a moment.',
    });
  }
}

/**
 * The workspace a new session starts in: the one this person used last, else the first they
 * joined. Null for someone with no workspace yet (onboarding creates one).
 */
async function startingWorkspace(prisma: PrismaClient, userId: string): Promise<string | null> {
  const last = await prisma.session.findFirst({
    where: {
      userId,
      activeWorkspaceId: { not: null },
      activeWorkspace: { memberships: { some: { userId } } },
    },
    orderBy: { updatedAt: 'desc' },
    select: { activeWorkspaceId: true },
  });
  if (last?.activeWorkspaceId) return last.activeWorkspaceId;
  const first = await prisma.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { workspaceId: true },
  });
  return first?.workspaceId ?? null;
}

export function createAuth({ config, prisma, mailer, rateLimitStore }: AuthDeps) {
  const appUrl = new URL(config.APP_URL);
  const log = new Logger('auth');

  const workspaces = organization({
    ac,
    roles,
    creatorRole: 'owner',
    invitationExpiresIn: INVITE_EXPIRES_IN_SECONDS,
    cancelPendingInvitationsOnReInvite: true,
    // Every sign-in method verifies the email (magic link, or Google/Microsoft's own check),
    // and an invite only opens for the address it was sent to.
    requireEmailVerificationOnInvitation: true,
    sendInvitationEmail: async ({
      id,
      email,
      role,
      organization: workspace,
      inviter,
      invitation,
    }) => {
      await sendOrExplain(() =>
        mailer.send(
          inviteEmail({
            to: email,
            url: inviteUrl(config.APP_URL, id),
            workspaceName: workspace.name,
            inviterName: inviter.user.name,
            inviterEmail: inviter.user.email,
            role: isRole(role) ? role : 'member',
            expiresAt: new Date(invitation.expiresAt),
          }),
        ),
      );
    },
    schema: {
      organization: { modelName: 'workspace' },
      member: { modelName: 'membership', fields: { organizationId: 'workspaceId' } },
      invitation: { modelName: 'invite', fields: { organizationId: 'workspaceId' } },
      session: { fields: { activeOrganizationId: 'activeWorkspaceId' } },
    },
  });

  // The /api/v1 controllers call these server-side, where each change is checked, audited and
  // CSRF-protected in one place, so their HTTP routes stay closed.
  const workspacePaths = Object.values(workspaces.endpoints)
    .map((endpoint) => (endpoint as { path?: string }).path)
    .filter((path): path is string => typeof path === 'string');

  return betterAuth({
    appName: 'Sotto',
    baseURL: config.APP_URL,
    basePath: AUTH_BASE_PATH,
    secret: config.AUTH_SECRET,
    trustedOrigins: [appUrl.origin],
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    telemetry: { enabled: false },
    logger: {
      level: config.NODE_ENV === 'production' ? 'error' : 'warn',
      // Only the message: Better Auth's extra arguments can carry request data.
      log: (level, message) => (level === 'error' ? log.error(message) : log.warn(message)),
    },
    emailAndPassword: { enabled: false },
    session: {
      expiresIn: SESSION_DAYS * 24 * 60 * 60,
      updateAge: 24 * 60 * 60,
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true },
    },
    socialProviders: {
      ...(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: config.GOOGLE_CLIENT_ID,
              clientSecret: config.GOOGLE_CLIENT_SECRET,
              prompt: 'select_account' as const,
            },
          }
        : {}),
      ...(config.MICROSOFT_CLIENT_ID && config.MICROSOFT_CLIENT_SECRET
        ? {
            microsoft: {
              clientId: config.MICROSOFT_CLIENT_ID,
              clientSecret: config.MICROSOFT_CLIENT_SECRET,
              tenantId: config.MICROSOFT_TENANT_ID,
              prompt: 'select_account' as const,
            },
          }
        : {}),
    },
    rateLimit: {
      enabled: config.AUTH_RATE_LIMIT === 'on',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/magic-link': { window: 60, max: 5 },
        '/magic-link/verify': { window: 60, max: 10 },
        '/passkey/verify-authentication': { window: 60, max: 10 },
        '/sign-in/social': { window: 60, max: 10 },
      },
      ...(rateLimitStore ? { customStorage: rateLimitStore } : {}),
    },
    disabledPaths: [
      ...workspacePaths,
      // Sotto has no passwords, and profile changes go through PATCH /api/v1/me.
      '/sign-up/email',
      '/sign-in/email',
      '/update-user',
      '/change-email',
      '/delete-user',
    ],
    advanced: {
      cookiePrefix: 'sotto',
      useSecureCookies: appUrl.protocol === 'https:',
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({
            data: {
              ...session,
              activeOrganizationId: await startingWorkspace(prisma, session.userId),
            },
          }),
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          await sendOrExplain(() => mailer.send(magicLinkEmail({ email, url })));
        },
      }),
      passkey({
        rpID: appUrl.hostname,
        rpName: 'Sotto',
        origin: appUrl.origin,
      }),
      workspaces,
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Injection token for the Better Auth instance. */
export const AUTH = Symbol('AUTH');
