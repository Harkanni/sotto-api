import { Controller, Get, Global, Inject, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiErrors } from '../common/errors.js';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { PrismaService, RedisService } from '../core.module.js';
import { Mailer } from '../mail/mailer.js';
import { AUTH, createAuth } from './auth.js';
import { AuthGuard, Public } from './auth.guard.js';
import { redisRateLimitStore } from './rate-limit.js';

export const SignInMethods = z
  .object({
    /** Email links work only when the server can send email. */
    magicLink: z.boolean(),
    passkey: z.boolean(),
    google: z.boolean(),
    microsoft: z.boolean(),
  })
  .meta({ id: 'SignInMethods' });

export type SignInMethods = z.infer<typeof SignInMethods>;

@ApiTags('auth')
@ApiErrors()
@Controller('sign-in-methods')
export class SignInMethodsController {
  constructor(@Inject(APP_CONFIG) private readonly config: ApiConfig) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Which sign-in options this server offers, for the sign-in screen.' })
  @ApiOkResponse({ standardSchema: SignInMethods })
  methods(): SignInMethods {
    const c = this.config;
    return {
      magicLink: Boolean(c.SMTP_URL),
      passkey: true,
      google: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
      microsoft: Boolean(c.MICROSOFT_CLIENT_ID && c.MICROSOFT_CLIENT_SECRET),
    };
  }
}

@Global()
@Module({
  controllers: [SignInMethodsController],
  providers: [
    {
      provide: AUTH,
      inject: [APP_CONFIG, PrismaService, Mailer, RedisService],
      useFactory: (config: ApiConfig, prisma: PrismaService, mailer: Mailer, redis: RedisService) =>
        createAuth({
          config,
          prisma: prisma.client,
          mailer,
          rateLimitStore:
            config.AUTH_RATE_LIMIT === 'on' ? redisRateLimitStore(redis.client) : undefined,
        }),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AUTH],
})
export class AuthModule {}
