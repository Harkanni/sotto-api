import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@sotto/db';
import { ApiException } from './errors.js';

/** Who is calling, filled in by the auth guard for every signed-in request. */
export interface RequestAuth {
  user: {
    id: string;
    email: string;
    name: string;
    emailVerified: boolean;
    image: string | null;
  };
  sessionId: string;
  /** The session's active workspace and the caller's role in it; null before onboarding. */
  workspace: { id: string; role: Role } | null;
  /** The client's address (through the gateway), for the audit log. */
  ip: string | null;
}

/** The parts of an Express request the api relies on. */
export interface ApiRequest extends IncomingMessage {
  id?: string;
  ip?: string;
  method: string;
  route?: { path?: string };
  auth?: RequestAuth;
}

/** Every request gets an id (or keeps the gateway's), echoed in the response and in errors. */
export function requestId(
  req: ApiRequest,
  res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  const incoming = req.headers['x-request-id'];
  req.id =
    typeof incoming === 'string' && /^[\w.-]{6,64}$/.test(incoming)
      ? incoming
      : `req_${randomBytes(6).toString('hex')}`;
  res.setHeader('X-Request-Id', req.id);
  next();
}

/** `@Ctx()` — the signed-in caller (the auth guard guarantees it outside `@Public()` routes). */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const auth = context.switchToHttp().getRequest<ApiRequest>().auth;
  if (!auth) throw new ApiException(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return auth;
});

/** The caller's active workspace and role, for routes marked `@RequireRole()`. */
export function workspaceOf(auth: RequestAuth): { id: string; role: Role } {
  if (!auth.workspace) {
    throw new ApiException(403, 'NO_WORKSPACE', 'Create or join a workspace first.');
  }
  return auth.workspace;
}
