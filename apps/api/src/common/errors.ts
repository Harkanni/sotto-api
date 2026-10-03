import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@sotto/db';
import { z } from 'zod';
import type { ApiRequest } from './request.js';

/**
 * Every error leaves the api as `{ error: { code, message, requestId } }`. The message is written
 * for people (the web shows it as is); the code is for programs; the request id ties a report to
 * the logs.
 */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super({ code, message }, status);
  }
}

export const ErrorBody = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string().optional(),
    }),
  })
  .meta({ id: 'Error' });

const STATUS_CODE: Record<number, string> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'TOO_LARGE',
  429: 'RATE_LIMITED',
};

const STATUS_MESSAGE: Record<number, string> = {
  400: 'Something in the request isn’t right.',
  401: 'Sign in to continue.',
  403: 'You don’t have access to this.',
  404: 'This doesn’t exist, or it was deleted.',
  409: 'That conflicts with something that already exists.',
  429: 'Too many attempts. Wait a minute and try again.',
};

/**
 * Better Auth's codes for workspace actions, in Sotto's words. The api calls these actions
 * server-side, so their errors reach people through this table.
 */
const AUTH_MESSAGES: Record<string, string> = {
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION:
    'Only admins and owners can invite people.',
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USER_WITH_THIS_ROLE: 'Only owners can invite another owner.',
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: 'They’re already in this workspace.',
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: 'They already have an invite. Resend it instead.',
  INVITATION_NOT_FOUND: 'This invite has expired or was withdrawn. Ask for a new one.',
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    'This invite was sent to a different email address. Sign in with that address to accept it.',
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
    'Confirm your email address before accepting invites.',
  YOU_ARE_NOT_ALLOWED_TO_CANCEL_THIS_INVITATION: 'Only admins and owners can withdraw invites.',
  INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION:
    'The person who invited you has left this workspace, so the invite no longer works.',
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER:
    'A workspace needs an owner. Make someone else an owner first.',
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER:
    'A workspace needs an owner. Make someone else an owner first.',
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER: 'Only owners can change an owner’s role.',
  YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER: 'Only admins and owners can remove people.',
  YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION:
    'Only admins and owners can change workspace settings.',
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: 'This workspace has reached its member limit.',
  INVITATION_LIMIT_REACHED: 'Too many invites are waiting. Withdraw some first.',
  ORGANIZATION_SLUG_ALREADY_TAKEN: 'That name is taken. Try another.',
  MEMBER_NOT_FOUND: 'This person isn’t in the workspace any more.',
  ORGANIZATION_NOT_FOUND: 'This workspace doesn’t exist any more.',
  USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION: 'You’re not a member of this workspace.',
  YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION: 'You’re not a member of this workspace.',
  NO_ACTIVE_ORGANIZATION: 'Create or join a workspace first.',
};

/** Better Auth (better-call) errors carry a numeric statusCode and a { code, message } body. */
function asAuthError(
  error: unknown,
): { statusCode: number; body: { code?: string; message?: string } } | null {
  if (!(error instanceof Error) || error.name !== 'APIError') return null;
  const { statusCode, body } = error as Error & { statusCode?: unknown; body?: unknown };
  if (typeof statusCode !== 'number') return null;
  return { statusCode, body: (body ?? {}) as { code?: string; message?: string } };
}

export interface ErrorPayload {
  status: number;
  code: string;
  message: string;
}

export function describeError(exception: unknown): ErrorPayload {
  if (exception instanceof ApiException) {
    return { status: exception.getStatus(), code: exception.code, message: exception.message };
  }
  const auth = asAuthError(exception);
  if (auth) {
    const code = auth.body.code ?? STATUS_CODE[auth.statusCode] ?? 'ERROR';
    const message =
      AUTH_MESSAGES[code] ??
      auth.body.message ??
      STATUS_MESSAGE[auth.statusCode] ??
      'Request failed.';
    return { status: auth.statusCode, code, message };
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const raw =
      typeof response === 'object' && response && 'message' in response
        ? (response as { message: unknown }).message
        : exception.message;
    const message = Array.isArray(raw) ? raw.join('; ') : String(raw);
    return {
      status,
      code: STATUS_CODE[status] ?? (status >= 500 ? 'INTERNAL' : 'ERROR'),
      message: status === 400 ? message : (STATUS_MESSAGE[status] ?? message),
    };
  }
  if (exception instanceof Prisma.PrismaClientKnownRequestError) {
    if (exception.code === 'P2025')
      return { status: 404, code: 'NOT_FOUND', message: STATUS_MESSAGE[404]! };
    if (exception.code === 'P2002')
      return { status: 409, code: 'CONFLICT', message: STATUS_MESSAGE[409]! };
  }
  return { status: 500, code: 'INTERNAL', message: 'Something went wrong on our side. Try again.' };
}

/** Error class and code only: messages can carry URLs with credentials or personal data. */
function summary(exception: unknown): string {
  if (exception instanceof Error) {
    const code = (exception as Error & { code?: unknown }).code;
    return `${exception.name}${typeof code === 'string' ? ` ${code}` : ''}`;
  }
  return typeof exception;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('http');

  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ApiRequest>();
    const { status, code, message } = describeError(exception);
    if (status >= 500) {
      this.log.error(
        `${request.method} ${request.route?.path ?? 'unmatched route'} → ${status} (${summary(exception)}) [${request.id ?? '-'}]`,
        exception instanceof Error
          ? exception.stack?.split('\n').slice(1, 6).join('\n')
          : undefined,
      );
    }
    this.adapterHost.httpAdapter.reply(
      http.getResponse(),
      { error: { code, message, requestId: request.id } },
      status,
    );
  }
}
