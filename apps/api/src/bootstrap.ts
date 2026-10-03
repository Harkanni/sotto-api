import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import { AUTH, AUTH_BASE_PATH, type Auth } from './auth/auth.js';
import { ApiExceptionFilter } from './common/errors.js';
import { requestId } from './common/request.js';
import { APP_CONFIG, type ApiConfig } from './config.js';

export const API_PREFIX = 'api/v1';

/**
 * Better Auth reads the raw request body itself, so Nest's own body parser stays off and
 * configureApp() adds the JSON parser after the auth handler. Every place that creates the app
 * (main.ts, the OpenAPI script, tests) passes these options.
 */
export const APP_OPTIONS = { bodyParser: false } as const;

/** Shared by main.ts, the OpenAPI script and tests, so all three see the same routes. */
export function configureApp(app: INestApplication): void {
  const config = app.get<ApiConfig>(APP_CONFIG);
  const express = (app as NestExpressApplication).getHttpAdapter().getInstance() as {
    disable(setting: string): void;
    set(setting: string, value: unknown): void;
    all(path: string, handler: (req: never, res: never) => unknown): void;
  };

  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'readyz'] });
  app.enableShutdownHooks();
  express.disable('x-powered-by');
  // The api sits behind one gateway (Caddy, Next's rewrite, later the Kubernetes gateway) on
  // a private network; trust it for the client address the audit log records.
  express.set('trust proxy', 'loopback, linklocal, uniquelocal');

  app.use(requestId);
  app.useSecurityHeaders();
  // Writes from another origin are refused before any handler runs (Sec-Fetch-Site / Origin).
  // The per-session CSRF token in the auth guard is the second layer.
  app.enableCsrfProtection({ trustedOrigins: [new URL(config.APP_URL).origin] });

  // Better Auth owns /api/auth/* (sign-in, sign-out, passkeys, OAuth callbacks). Mounted before
  // the JSON parser so it receives the untouched body.
  express.all(`${AUTH_BASE_PATH}/*splat`, toNodeHandler(app.get<Auth>(AUTH)));
  (app as NestExpressApplication).useBodyParser('json', { limit: '1mb' });

  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.useGlobalFilters(new ApiExceptionFilter(app.get(HttpAdapterHost)));
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Sotto API')
    .setDescription(
      'Private AI for your team’s memos and meetings. Sign-in lives at /api/auth (Better Auth); ' +
        'writes need the session cookie and the X-CSRF-Token from GET /api/v1/me.',
    )
    .setVersion('1')
    .addCookieAuth('sotto.session_token')
    .build();
  return SwaggerModule.createDocument(app, config);
}
