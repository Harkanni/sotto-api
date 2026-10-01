// Writes openapi.json at the repo root from the code's decorators. CI fails when it's stale, and
// sotto-web generates its typed client from it. No database or queue is contacted.
import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { buildOpenApi, configureApp } from './bootstrap.js';

process.env.DATABASE_URL ??= 'postgresql://openapi:openapi@localhost:5432/openapi';

const app = await NestFactory.create(AppModule, { logger: false });
configureApp(app);
const document = buildOpenApi(app);
const target = resolve(import.meta.dirname, '../../../openapi.json');
await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
await app.close();
console.log(`wrote ${target}`);
