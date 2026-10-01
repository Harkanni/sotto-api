import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, type ApiConfig } from '../config.js';
import { HealthService } from './health.service.js';

export interface StatusResponse {
  service: 'sotto-api';
  version: string;
  commit: string;
  environment: string;
  uptimeSeconds: number;
  ready: boolean;
  checks: Record<string, boolean>;
}

@ApiTags('status')
@Controller('status')
export class StatusController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: ApiConfig,
    @Inject(HealthService) private readonly health: HealthService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Public build and dependency summary, used by the web status page.' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['service', 'version', 'commit', 'environment', 'uptimeSeconds', 'ready', 'checks'],
      properties: {
        service: { type: 'string', enum: ['sotto-api'] },
        version: { type: 'string' },
        commit: { type: 'string' },
        environment: { type: 'string' },
        uptimeSeconds: { type: 'integer' },
        ready: { type: 'boolean' },
        checks: { type: 'object', additionalProperties: { type: 'boolean' } },
      },
    },
  })
  async status(): Promise<StatusResponse> {
    const readiness = await this.health.readiness();
    return {
      service: 'sotto-api',
      version: this.config.APP_VERSION,
      commit: this.config.GIT_SHA,
      environment: this.config.NODE_ENV,
      uptimeSeconds: Math.round(process.uptime()),
      ready: readiness.ready,
      checks: Object.fromEntries(
        Object.entries(readiness.checks).map(([name, result]) => [name, result.ok]),
      ),
    };
  }
}
