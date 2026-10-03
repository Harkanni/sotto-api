import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { API_PREFIX, APP_OPTIONS, buildOpenApi, configureApp } from './bootstrap.js';
import { APP_CONFIG, type ApiConfig } from './config.js';

const production = process.env.NODE_ENV === 'production';

const app = await NestFactory.create(AppModule, {
  ...APP_OPTIONS,
  // JSON logs in production so they can be shipped and queried; readable logs locally.
  logger: new ConsoleLogger({ prefix: 'sotto-api', json: production }),
});
configureApp(app);
if (!production) SwaggerModule.setup(`${API_PREFIX}/docs`, app, () => buildOpenApi(app));

const config = app.get<ApiConfig>(APP_CONFIG);
await app.listen(config.PORT, '0.0.0.0');
new Logger('bootstrap').log(`listening on :${config.PORT}`);
