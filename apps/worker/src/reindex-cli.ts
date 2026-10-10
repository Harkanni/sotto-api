/**
 * `node dist/reindex-cli.js [--swap] [--batch=32] [--limit=N]` — fills in the configured
 * embedding model (AI_EMBEDDINGS) for every chunk, beside the live index; `--swap` then makes
 * it the index searches use. Safe to stop and run again: it carries on where it left off.
 *
 * In Compose: `docker compose run --rm worker node dist/reindex-cli.js --swap`.
 */
import { aiEnv, embeddingProviderFrom } from '@sotto/ai';
import { baseEnv, loadEnv } from '@sotto/config';
import { createPrismaClient } from '@sotto/db';
import { z } from 'zod';
import { log } from './log.js';
import { ReindexError, reindex } from './reindex.js';

const env = loadEnv(baseEnv.extend({ DATABASE_URL: z.string().min(1), ...aiEnv.shape }));
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const prisma = createPrismaClient(env.DATABASE_URL);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  const result = await reindex(prisma, embeddingProviderFrom(env), {
    swap: args.includes('--swap'),
    batch: Number(flag('batch') ?? 32),
    ...(flag('limit') ? { limit: Number(flag('limit')) } : {}),
    signal: controller.signal,
    log: (message, fields) => log('info', message, fields),
  });
  log('info', 're-index done', { ...result });
} catch (error) {
  const code =
    error instanceof ReindexError ? error.code : error instanceof Error ? error.name : 'error';
  log('error', 're-index stopped', {
    code,
    hint:
      code === 'incomplete'
        ? 'Some chunks still lack the new model. Run again without --swap, then with it.'
        : code === 'not_private'
          ? 'Embeddings must run in the cluster (BRIEF §3).'
          : undefined,
  });
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
