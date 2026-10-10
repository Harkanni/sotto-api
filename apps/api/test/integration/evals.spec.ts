import { FakeEmbeddingProvider } from '@sotto/ai';
import { createPrismaClient, type PrismaClient } from '@sotto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Client, markdown, runEval } from '../../../../evals/score.ts';
import { onFileUploaded, onTranscribeCompleted, pgVectors } from '../../../worker/src/pipeline.js';
import { StorageService } from '../../src/infra.module.js';
import { Person, bootApp, withoutStorage, type TestApp } from './harness.js';

/** Reads a whole answer stream and returns the final answer. */
function readStream(text: string) {
  const done = text
    .split('\n\n')
    .filter((b) => b.startsWith('event: done'))
    .map((b) => JSON.parse(b.split('\ndata: ')[1]!) as { answer: Record<string, unknown> })[0];
  if (!done) throw new Error(`The answer didn't finish: ${text.slice(-300)}`);
  return done.answer as {
    content: string;
    notFound: boolean;
    passagesOnly: boolean;
    isMock: boolean;
    status: string;
    citations: { title: string | null; startMs: number | null }[];
  };
}

/** Searches and asks through the api, as `person`, the way the web does. */
export function clientFor(person: Person): Client {
  return {
    async search(question) {
      const res = await person.get(`/api/v1/search?q=${encodeURIComponent(question)}`).expect(200);
      type Hit = {
        rank: number;
        file: { title: string };
        page?: number | null;
        startMs?: number;
        endMs?: number;
      };
      const body = res.body as {
        mode: 'hybrid' | 'keyword';
        files: { file: { title: string } }[];
        passages: Hit[];
        moments: Hit[];
      };
      return {
        mode: body.mode,
        files: body.files.map((f) => f.file.title),
        hits: [...body.passages, ...body.moments].map((h) => ({
          rank: h.rank,
          title: h.file.title,
          page: h.page ?? null,
          startMs: h.startMs ?? null,
          endMs: h.endMs ?? null,
        })),
      };
    },
    async ask(question) {
      const chat = await person.post('/api/v1/conversations', {}).expect(201);
      const res = await person
        .post(`/api/v1/conversations/${chat.body.id}/messages`, { content: question })
        .buffer(true)
        .parse((r, done) => {
          let data = '';
          r.on('data', (c: Buffer) => (data += c.toString()));
          r.on('end', () => done(null, data));
        })
        .expect(200);
      return readStream(res.body as string);
    },
  };
}

/**
 * The eval set (evals/kestrel.ts) in-process: the real sample content goes through the real
 * worker handlers into Postgres (full-text and pgvector), then every question is searched and
 * asked through the api, by the owner and by a viewer who can't open Board and finance.
 *
 * Embeddings here are the labelled hash mock and there's no chat model, so this measures the
 * keyword half and the passages-only answers, on every CI run. CI's `evals` job runs the same set
 * end to end with a real embedding model (scripts/eval.ts).
 */
describe.skipIf(withoutStorage)('evals (keyword search, passages only)', () => {
  let t: TestApp;
  let db: PrismaClient;
  const people = {} as Record<'owner' | 'viewer', Person>;

  beforeAll(async () => {
    process.env.AI_EMBEDDINGS = 'fake:fake-hash';
    process.env.ASK_RATE_PER_MINUTE = '1000';
    await fetch(`${process.env.TEST_S3_ENDPOINT}/${process.env.TEST_S3_BUCKET ?? 'sotto-test'}`, {
      method: 'PUT',
    }).catch(() => undefined);
    t = await bootApp();
    db = createPrismaClient(t.databaseUrl);
    people.owner = new Person(t, 'amaka@evals.example');
    await people.owner.signIn();
    await people.owner.post('/api/v1/workspaces', { name: 'Kestrel Labs' }).expect(201);
    await people.owner.post('/api/v1/onboarding/sample-content').expect(200);
    const invite = await people.owner
      .post('/api/v1/invites', { email: 'priya@evals.example', role: 'viewer' })
      .expect(201);
    people.viewer = new Person(t, 'priya@evals.example');
    await people.viewer.signIn();
    await people.viewer.post(`/api/v1/invites/${invite.body.id}/accept`).expect(200);
    await people.viewer.refresh();

    // The worker's own handlers, on the jobs the api queued.
    const deps = {
      prisma: db,
      storage: t.app.get(StorageService),
      embeddings: new FakeEmbeddingProvider(8, 'fake-hash'),
      chat: null,
      maxDocumentBytes: 10 * 1024 * 1024,
      vectors: pgVectors(db),
      publish: async () => undefined,
      emit: async () => undefined,
    };
    for (const job of t.queue.sent) {
      if (job.queue === 'file.uploaded') await onFileUploaded(deps, job.message as never);
      if (job.queue === 'transcribe.completed')
        await onTranscribeCompleted(deps, job.message as never);
    }
    const notReady = await db.file.count({ where: { status: { not: 'READY' } } });
    expect(notReady).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    await t?.close();
  });

  it('passes the eval set, and the viewer never reaches the board', async () => {
    const lines: string[] = [];
    const report = await runEval({
      owner: clientFor(people.owner),
      viewer: clientFor(people.viewer),
      log: (line) => lines.push(line),
    });
    console.log(`${lines.join('\n')}\n\n${markdown(report)}`);
    expect(report.mode).toBe('keyword');
    expect(report.model).toBe('none');
    expect(report.leaks).toEqual([]);
    expect(report.failures).toEqual([]);
  }, 300_000);
});
