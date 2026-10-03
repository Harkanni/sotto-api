import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../auth/auth.guard.js';
import { HealthService, type Readiness } from './health.service.js';

/**
 * Probes for Docker, Compose and (later) Kubernetes. They live outside /api/v1 so a probe never
 * depends on routing, auth or versioning.
 */
@ApiExcludeController()
@Public()
@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: the process is up. Never checks dependencies (that would restart healthy pods). */
  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: dependencies answer, so it's safe to send traffic here. A 503 still carries the
   * per-dependency result (not the api's error shape), so a failing probe says what is down.
   */
  @Get('readyz')
  async ready(
    @Res({ passthrough: true }) res: { status(code: number): unknown },
  ): Promise<Readiness> {
    const result = await this.health.readiness();
    if (!result.ready) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return result;
  }
}
