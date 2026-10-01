import { Inject, Injectable } from '@nestjs/common';
import { DEPENDENCY_CHECKS, type DependencyCheck } from './checks.js';

export interface CheckResult {
  ok: boolean;
  ms: number;
  /** An error code or class name only. Messages can contain URLs with credentials. */
  error?: string;
}

export interface Readiness {
  ready: boolean;
  checks: Record<string, CheckResult>;
}

function summarize(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' ? code : error.name;
  }
  return 'error';
}

@Injectable()
export class HealthService {
  constructor(@Inject(DEPENDENCY_CHECKS) private readonly checks: DependencyCheck[]) {}

  async readiness(timeoutMs = 2_000): Promise<Readiness> {
    const entries = await Promise.all(
      this.checks.map(async (dependency): Promise<[string, CheckResult]> => {
        const started = performance.now();
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            dependency.check(controller.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
              }, timeoutMs);
            }),
          ]);
          return [dependency.name, { ok: true, ms: Math.round(performance.now() - started) }];
        } catch (error) {
          return [
            dependency.name,
            { ok: false, ms: Math.round(performance.now() - started), error: summarize(error) },
          ];
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    return { ready: entries.every(([, r]) => r.ok), checks };
  }
}
