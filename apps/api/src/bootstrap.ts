import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts, the OpenAPI script and tests, so all three see the same routes. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: ['healthz', 'readyz'] });
  app.enableShutdownHooks();
  const http = app.getHttpAdapter().getInstance() as { disable?: (setting: string) => void };
  http.disable?.('x-powered-by');
}

export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Sotto API')
    .setDescription('Private AI for your team’s memos and meetings.')
    .setVersion('1')
    .build();
  return SwaggerModule.createDocument(app, config);
}
