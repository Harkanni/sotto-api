import { createPrismaClient, type PrismaClient } from '@sotto/db';
import { Derived } from '@sotto/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/infra.module.js';
import { SAMPLE_DOCS, SAMPLE_MEETINGS } from '../../src/onboarding/sample-files.js';
import { Person, bootApp, withoutStorage, type TestApp } from './harness.js';

/**
 * Sample content as real files, document content, transcripts, notes, positions and Continue
 * listening. Ada owns the workspace; Tunde is a member; Priya a viewer.
 */
describe.skipIf(withoutStorage)('meetings, content and sample files', () => {
  let t: TestApp;
  let db: PrismaClient;
  let storage: StorageService;
  let workspaceId: string;
  const people = {} as Record<'ada' | 'tunde' | 'priya', Person>;

  const files = async (who: Person, query = '') =>
    (await who.get(`/api/v1/files?limit=100${query}`).expect(200)).body.items as {
      id: string;
      title: string;
      kind: string;
      source: string;
      status: string;
    }[];
  const byTitle = async (title: string) =>
    db.file.findFirstOrThrow({ where: { workspaceId, title } });

  beforeAll(async () => {
    t = await bootApp();
    db = createPrismaClient(t.databaseUrl);
    storage = t.app.get(StorageService);
    await fetch(`${process.env.TEST_S3_ENDPOINT}/${process.env.TEST_S3_BUCKET ?? 'sotto-test'}`, {
      method: 'PUT',
    }).catch(() => undefined);
    people.ada = new Person(t, 'ada@meet.example');
    await people.ada.signIn();
    workspaceId = (await people.ada.post('/api/v1/workspaces', { name: 'Meet Co' }).expect(201))
      .body.id;
    for (const [key, role] of [
      ['tunde', 'member'],
      ['priya', 'viewer'],
    ] as const) {
      const email = `${key}@meet.example`;
      const invite = await people.ada.post('/api/v1/invites', { email, role }).expect(201);
      people[key] = new Person(t, email);
      await people[key].signIn();
      await people[key].post(`/api/v1/invites/${invite.body.id}/accept`).expect(200);
      await people[key].refresh();
    }
    await people.ada.refresh();
  });

  afterAll(async () => {
    await db?.$disconnect();
    await t?.close();
  });

  it('loads sample memos and meetings as real files, once', async () => {
    const before = t.queue.sent.length;
    await people.ada.post('/api/v1/onboarding/sample-content').expect(200);
    const jobs = t.queue.sent.slice(before);
    expect(jobs.filter((j) => j.queue === 'file.uploaded')).toHaveLength(SAMPLE_DOCS.length);
    expect(jobs.filter((j) => j.queue === 'transcribe.completed')).toHaveLength(
      SAMPLE_MEETINGS.length,
    );

    const all = await files(people.ada);
    expect(all.every((f) => f.source === 'sample')).toBe(true);
    expect(all.filter((f) => f.kind === 'audio')).toHaveLength(SAMPLE_MEETINGS.length);

    // The memo is really in storage, and the meeting's transcript waits where the worker reads it.
    const roadmap = await byTitle('Q4 roadmap memo');
    expect((await storage.head(roadmap.storageKey)).size).toBeGreaterThan(100);
    const weekly = await byTitle('Weekly product sync');
    expect(weekly.status).toBe('TRANSCRIBING');
    await storage.head(storage.keys.derived(workspaceId, weekly.id, Derived.transcript));

    // Loading again changes nothing.
    const count = all.length;
    await people.ada.post('/api/v1/onboarding/sample-content').expect(200);
    expect(await files(people.ada)).toHaveLength(count);
  });

  it('keeps restricted sample files out of sight', async () => {
    expect((await files(people.ada)).map((f) => f.title)).toContain('Board update, September');
    expect((await files(people.tunde)).map((f) => f.title)).not.toContain(
      'Board update, September',
    );
  });

  it('serves a document’s pages once it’s ready', async () => {
    const memo = await byTitle('Pricing review notes');
    const conflict = await people.tunde.get(`/api/v1/files/${memo.id}/content`).expect(409);
    expect(conflict.body.error.code).toBe('NOT_READY');
    // What the worker does when it finishes reading:
    await storage.putJson(storage.keys.derived(workspaceId, memo.id, Derived.pages), {
      pages: [{ page: 1, text: 'Decision: keep the free tier at three members.' }],
    });
    await db.file.update({ where: { id: memo.id }, data: { status: 'READY' } });
    const content = await people.priya.get(`/api/v1/files/${memo.id}/content`).expect(200);
    expect(content.body).toEqual({
      paged: false,
      pages: [{ page: 1, text: 'Decision: keep the free tier at three members.' }],
    });
  });

  it('gives transcripts with search, and the notes a sample meeting came with', async () => {
    const weekly = await byTitle('Weekly product sync');
    await people.priya.get(`/api/v1/files/${weekly.id}/transcript`).expect(404);
    // The worker writes these from transcript.json:
    await db.transcript.create({
      data: {
        workspaceId,
        fileId: weekly.id,
        language: 'en',
        engine: 'sample',
        model: 'none',
        segments: {
          create: [
            {
              workspaceId,
              idx: 0,
              startMs: 12_000,
              endMs: 30_000,
              speaker: 'Amaka',
              text: 'Where are we on the design partners?',
            },
            {
              workspaceId,
              idx: 1,
              startMs: 31_000,
              endMs: 57_000,
              speaker: 'Ada',
              text: 'Four of five have signed: 100% ready_soon.',
            },
          ],
        },
      },
    });
    const transcript = await people.priya
      .get(`/api/v1/files/${weekly.id}/transcript?q=PARTNERS`)
      .expect(200);
    expect(transcript.body).toMatchObject({ engine: 'sample', isMock: false, matches: [0] });
    expect(transcript.body.segments[1]).toMatchObject({ startMs: 31_000, speaker: 'Ada' });
    // Wildcards are literal.
    const literal = await people.priya
      .get(`/api/v1/files/${weekly.id}/transcript?q=100%25`)
      .expect(200);
    expect(literal.body.matches).toEqual([1]);
    const underscore = await people.priya
      .get(`/api/v1/files/${weekly.id}/transcript?q=y_s`)
      .expect(200);
    expect(underscore.body.matches).toEqual([1]);

    const notes = await people.priya.get(`/api/v1/files/${weekly.id}/insights`).expect(200);
    expect(notes.body).toMatchObject({ model: 'sample', isMock: false });
    expect(notes.body.actionItems[0]).toMatchObject({ owner: 'Tunde', atMs: 58_000 });
    expect(notes.body.chapters[0]).toEqual({ title: 'Launch status', startMs: 0 });

    const board = await byTitle('Board update, September');
    await people.tunde.get(`/api/v1/files/${board.id}/insights`).expect(404);
  });

  it('gathers action items from meetings you can open, yours marked', async () => {
    const weekly = await byTitle('Weekly product sync');
    await db.file.update({ where: { id: weekly.id }, data: { status: 'READY' } });
    await people.ada.patch('/api/v1/me', { name: 'Ada Okafor' }).expect(200);
    const items = (await people.ada.get('/api/v1/action-items').expect(200)).body as {
      text: string;
      owner: string;
      mine: boolean;
      meeting: { id: string };
    }[];
    const weeklyItems = items.filter((i) => i.meeting.id === weekly.id);
    expect(weeklyItems.map((i) => i.owner)).toEqual(['Tunde', 'Ada', 'Sofia']);
    expect(weeklyItems.find((i) => i.owner === 'Ada')!.mine).toBe(true);
    expect(weeklyItems.find((i) => i.owner === 'Tunde')!.mine).toBe(false);
    // Tunde can't open Board: nothing from there reaches him.
    const board = await byTitle('Board update, September');
    const tunde = (await people.tunde.get('/api/v1/action-items').expect(200)).body as {
      meeting: { id: string };
    }[];
    expect(tunde.some((i) => i.meeting.id === board.id)).toBe(false);
  });

  it('says sample meetings have no audio', async () => {
    const weekly = await byTitle('Weekly product sync');
    const res = await people.priya
      .get(`/api/v1/files/${weekly.id}/download?inline=true`)
      .expect(409);
    expect(res.body.error.code).toBe('NO_AUDIO');
    await people.priya.get(`/api/v1/files/${weekly.id}/peaks`).expect(404);
    await storage.putJson(storage.keys.derived(workspaceId, weekly.id, Derived.peaks), {
      durationMs: 1000,
      peaks: [0.2, 1, 0.5],
    });
    expect(
      (await people.priya.get(`/api/v1/files/${weekly.id}/peaks`).expect(200)).body.peaks,
    ).toEqual([0.2, 1, 0.5]);
  });

  it('remembers where each person stopped, for Continue listening', async () => {
    const weekly = await byTitle('Weekly product sync');
    const allhands = await byTitle('All-hands, September');
    await db.file.updateMany({
      where: { id: { in: [weekly.id, allhands.id] } },
      data: { status: 'READY', durationMs: 600_000 },
    });
    // Viewers listen too; a position is personal, not a change to the file.
    await people.priya
      .put(`/api/v1/files/${weekly.id}/position`, { positionMs: 120_000 })
      .expect(204);
    await people.priya
      .put(`/api/v1/files/${allhands.id}/position`, { positionMs: 2_000 })
      .expect(204);
    await people.tunde
      .put(`/api/v1/files/${allhands.id}/position`, { positionMs: 300_000 })
      .expect(204);

    const priya = (await people.priya.get('/api/v1/continue-listening').expect(200)).body;
    expect(priya.map((r: { file: { id: string } }) => r.file.id)).toEqual([weekly.id]); // 2 s isn't "started"
    expect(priya[0].positionMs).toBe(120_000);

    // Finished (within 10 s of the end): it drops off.
    await people.priya
      .put(`/api/v1/files/${weekly.id}/position`, { positionMs: 595_000 })
      .expect(204);
    expect((await people.priya.get('/api/v1/continue-listening').expect(200)).body).toEqual([]);

    // Trashed: gone from the list.
    const tunde = (await people.tunde.get('/api/v1/continue-listening').expect(200)).body;
    expect(tunde).toHaveLength(1);
    await people.ada.delete(`/api/v1/files/${allhands.id}`).expect(204);
    expect((await people.tunde.get('/api/v1/continue-listening').expect(200)).body).toEqual([]);
  });

  it('adds the files to a workspace that loaded only Phase 3’s sample collections', async () => {
    const owner = new Person(t, 'old@meet.example');
    await owner.signIn();
    const id = (await owner.post('/api/v1/workspaces', { name: 'Old Co' }).expect(201)).body.id;
    await owner.refresh();
    // Phase 3 recorded the collections only.
    const product = await db.collection.create({ data: { workspaceId: id, name: 'Product' } });
    await db.workspace.update({
      where: { id },
      data: {
        metadata: JSON.stringify({
          sample: { loadedAt: new Date().toISOString(), collections: { product: product.id } },
        }),
      },
    });
    await owner.post('/api/v1/onboarding/sample-content').expect(200);
    const titles = (await owner.get('/api/v1/files?limit=100').expect(200)).body.items.map(
      (f: { title: string }) => f.title,
    );
    expect(titles).toContain('Q4 roadmap memo');
    expect(titles).toContain('Weekly product sync');
    expect(titles).not.toContain('Support playbook'); // its collection doesn't exist there
  });

  it('retries a sample load that failed part-way without adding anything twice', async () => {
    const owner = new Person(t, 'retry@meet.example');
    await owner.signIn();
    const id = (await owner.post('/api/v1/workspaces', { name: 'Retry Co' }).expect(201)).body.id;
    await owner.refresh();
    t.queue.failAfter = 2; // two samples get queued, then the broker goes down
    try {
      await owner.post('/api/v1/onboarding/sample-content').expect(500);
    } finally {
      t.queue.failAfter = null;
    }
    // The one whose job failed was taken back; the two that made it stay.
    expect(await db.file.count({ where: { workspaceId: id } })).toBe(2);

    await owner.post('/api/v1/onboarding/sample-content').expect(200);
    const titles = (await db.file.findMany({ where: { workspaceId: id } })).map((f) => f.title);
    expect(new Set(titles).size).toBe(titles.length);
    expect(titles).toHaveLength(SAMPLE_DOCS.length + SAMPLE_MEETINGS.length);
    const audit = await owner.get('/api/v1/audit?action=onboarding').expect(200);
    expect(audit.body.entries).toHaveLength(1);
  });
});
