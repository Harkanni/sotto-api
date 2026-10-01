import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthService, type Readiness } from './health.service.js';

/**
 * Probes for Docker, Compose and (later) Kubernetes. They live outside /api/v1 so a probe never
 * depends on routing, auth or versioning.
 */
@ApiExcludeController()
@Controller()
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: the process is up. Never checks dependencies (that would restart healthy pods). */
  @Get('healthz')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies answer, so it's safe to send traffic here. */
  @Get('readyz')
  async ready(): Promise<Readiness> {
    const result = await this.health.readiness();
    if (!result.ready) throw new ServiceUnavailableException(result);
    return result;
  }
}
