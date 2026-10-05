import type { MessageEvent } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@sotto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventsHub } from '../../src/events/events.controller.js';
import type { RequestAuth } from '../../src/common/request.js';
import { StorageService } from '../../src/infra.module.js';
import { Person, bootApp, withoutStorage, type TestApp } from './harness.js';

interface FileRow {
  id: string;
  title: string;
  status: string;
  access: string;
  sensitivity: string;
  collection: { id: string; name: string } | null;
  deletedAt: string | null;
  purgeAt: string | null;
}

/**
 * Uploads, files, the trash and live events, with one person per role:
 * Ada (owner), Kwame (admin), Tunde (member), Priya (viewer).
 */
describe.skipIf(withoutStorage)('uploads, files and the trash', () => {
  let t: TestApp;
  let db: PrismaClient;
  let workspaceId: string;
  const people = {} as Record<'ada' | 'kwame' | 'tunde' | 'priya', Person>;
  const collections = {} as Record<'product' | 'board', string>;

  /** The browser's whole upload: start, PUT each part to storage, complete. */
  async function upload(
    who: Person,
    filename: string,
    body: Buffer | string,
    extra: Record<string, unknown> = {},
  ): Promise<FileRow> {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const start = await who
      .post('/api/v1/uploads', { filename, sizeBytes: bytes.length, ...extra })
      .expect(201);
    const { partSize, parts, file } = start.body as {
      partSize: number;
      parts: { partNumber: number; url: string }[];
      file: FileRow;
    };
    const etags = [];
    for (const part of parts) {
      const slice = bytes.subarray((part.partNumber - 1) * partSize, part.partNumber * partSize);
      const res = await fetch(part.url, { method: 'PUT', body: slice });
      expect(res.status).toBe(200);
      etags.push({ partNumber: part.partNumber, etag: res.headers.get('etag')! });
    }
    return (await who.post(`/api/v1/uploads/${file.id}/complete`, { parts: etags }).expect(200))
      .body as FileRow;
  }

  const titles = async (who: Person, query = '') =>
    ((await who.get(`/api/v1/files${query}`).expect(200)).body.items as FileRow[])
      .map((f) => f.title)
      .sort();

  beforeAll(async () => {
    t = await bootApp();
    db = createPrismaClient(t.databaseUrl);
    // The test bucket may not exist yet on a fresh S3 server.
    await fetch(`${process.env.TEST_S3_ENDPOINT}/${process.env.TEST_S3_BUCKET ?? 'sotto-test'}`, {
      method: 'PUT',
    }).catch(() => undefined);

    people.ada = new Person(t, 'ada@files.example');
    await people.ada.signIn();
    await people.ada.patch('/api/v1/me', { name: 'Ada' }).expect(200);
    workspaceId = (await people.ada.post('/api/v1/workspaces', { name: 'Files Co' }).expect(201))
      .body.id;
    for (const [key, role] of [
      ['kwame', 'admin'],
      ['tunde', 'member'],
      ['priya', 'viewer'],
    ] as const) {
      const email = `${key}@files.example`;
      const invite = await people.ada.post('/api/v1/invites', { email, role }).expect(201);
      people[key] = new Person(t, email);
      await people[key].signIn();
      await people[key].patch('/api/v1/me', { name: key }).expect(200);
      await people[key].post(`/api/v1/invites/${invite.body.id}/accept`).expect(200);
      await people[key].refresh();
    }
    await people.ada.refresh();
    collections.product = (
      await people.ada.post('/api/v1/collections', { name: 'Product' }).expect(201)
    ).body.id;
    collections.board = (
      await people.ada.post('/api/v1/collections', { name: 'Board', restricted: true }).expect(201)
    ).body.id;
  });

  afterAll(async () => {
    await db?.$disconnect();
    await t?.close();
  });

  it('uploads straight to storage and queues processing', async () => {
    const file = await upload(people.tunde, 'Roadmap Q3.md', '# Roadmap\nShip answers.', {
      collectionId: collections.product,
    });
    expect(file).toMatchObject({ title: 'Roadmap Q3', status: 'uploaded', access: 'edit' });
    expect(file.collection?.name).toBe('Product');
    const job = t.queue.sent.at(-1)!;
    expect(job.queue).toBe('file.uploaded');
    expect(job.message).toMatchObject({ fileId: file.id, workspaceId, kind: 'DOCUMENT' });
    const row = await db.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.uploadId).toBeNull();
    expect(row.storageKey).toBe(`files/${workspaceId}/${file.id}/original.md`);

    const audit = await people.ada.get('/api/v1/audit').expect(200);
    expect(audit.body.entries[0]).toMatchObject({
      action: 'file.uploaded',
      summary: 'Uploaded “Roadmap Q3”',
    });
  });

  it('refuses viewers, unknown types, oversized files and closed collections', async () => {
    await people.priya.post('/api/v1/uploads', { filename: 'x.pdf', sizeBytes: 10 }).expect(403);
    const type = await people.tunde
      .post('/api/v1/uploads', { filename: 'deck.pptx', sizeBytes: 10 })
      .expect(415);
    expect(type.body.error.code).toBe('UNSUPPORTED_TYPE');
    await people.tunde
      .post('/api/v1/uploads', { filename: 'big.wav', sizeBytes: 3 * 1024 ** 3 })
      .expect(413);
    await people.tunde
      .post('/api/v1/uploads', {
        filename: 'x.pdf',
        sizeBytes: 10,
        collectionId: collections.board,
      })
      .expect(404);
  });

  it('keeps an unfinished upload to its uploader, and resumes it', async () => {
    const start = await people.tunde
      .post('/api/v1/uploads', { filename: 'Interview.m4a', sizeBytes: 12 })
      .expect(201);
    const id = start.body.file.id as string;
    expect(start.body.file.status).toBe('uploading');
    expect(await titles(people.ada)).not.toContain('Interview');
    await people.ada.get(`/api/v1/files/${id}`).expect(404);
    await people.ada.get(`/api/v1/uploads/${id}`).expect(404);

    // Half the parts are missing: complete refuses.
    await people.tunde
      .post(`/api/v1/uploads/${id}/complete`, { parts: [{ partNumber: 2, etag: 'x' }] })
      .expect(400);
    const resumed = await people.tunde.get(`/api/v1/uploads/${id}`).expect(200);
    expect(resumed.body.uploadedParts).toEqual([]);
    expect(resumed.body.parts).toHaveLength(1);

    await people.tunde.delete(`/api/v1/uploads/${id}`).expect(204);
    expect(await db.file.findUnique({ where: { id } })).toBeNull();
  });

  it('hides restricted collections’ files from everyone without a grant', async () => {
    const pack = await upload(people.kwame, 'Board pack.pdf', '%PDF-1.4 not really', {
      collectionId: collections.board,
    });
    expect(await titles(people.ada)).toContain('Board pack');
    expect(await titles(people.tunde)).not.toContain('Board pack');
    expect(await titles(people.priya)).not.toContain('Board pack');
    await people.tunde.get(`/api/v1/files/${pack.id}`).expect(404);
    await people.priya.get(`/api/v1/files/${pack.id}/download`).expect(404);
    await people.tunde.get(`/api/v1/files?collection=${collections.board}`).expect(200);
  });

  it('lets members change their own unfiled files, and only view others’', async () => {
    const mine = await upload(people.tunde, 'Tunde notes.txt', 'notes');
    const adas = await upload(people.ada, 'Ada notes.txt', 'notes');
    expect((await people.priya.get(`/api/v1/files/${mine.id}`).expect(200)).body.access).toBe(
      'view',
    );
    expect((await people.tunde.get(`/api/v1/files/${adas.id}`).expect(200)).body.access).toBe(
      'view',
    );
    await people.tunde.patch(`/api/v1/files/${adas.id}`, { title: 'Mine now' }).expect(403);
    await people.priya.patch(`/api/v1/files/${mine.id}`, { title: 'Nope' }).expect(403);
    const renamed = await people.tunde
      .patch(`/api/v1/files/${mine.id}`, {
        title: 'Field notes',
        tags: ['Research', 'research'],
        pinned: true,
      })
      .expect(200);
    expect(renamed.body).toMatchObject({ title: 'Field notes', tags: ['research'], pinned: true });
  });

  it('moves files and relabels them, keeping chunks in step', async () => {
    const file = await upload(people.tunde, 'Pricing.md', '# Pricing', {
      collectionId: collections.product,
    });
    await db.chunk.create({
      data: {
        workspaceId,
        fileId: file.id,
        collectionId: collections.product,
        sensitivity: 'INTERNAL',
        idx: 0,
        text: 'Pricing',
        tokenCount: 1,
      },
    });
    // Tunde can't put it somewhere he can't see.
    await people.tunde
      .patch(`/api/v1/files/${file.id}`, { collectionId: collections.board })
      .expect(404);

    await people.tunde.patch(`/api/v1/files/${file.id}`, { sensitivity: 'restricted' }).expect(200);
    const lowered = await people.tunde
      .patch(`/api/v1/files/${file.id}`, { sensitivity: 'internal' })
      .expect(403);
    expect(lowered.body.error.code).toBe('ADMIN_REQUIRED');

    // An admin moves it into Board: now Tunde can't see it.
    await people.kwame
      .patch(`/api/v1/files/${file.id}`, {
        collectionId: collections.board,
        sensitivity: 'confidential',
      })
      .expect(200);
    await people.tunde.get(`/api/v1/files/${file.id}`).expect(404);
    const chunk = await db.chunk.findFirstOrThrow({ where: { fileId: file.id } });
    expect(chunk).toMatchObject({ collectionId: collections.board, sensitivity: 'CONFIDENTIAL' });

    const actions = (await people.ada.get('/api/v1/audit').expect(200)).body.entries.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toContain('file.moved');
    expect(actions).toContain('file.relabelled');
  });

  it('trashes, restores and deletes for good', async () => {
    const file = await upload(people.tunde, 'Old memo.md', 'old', {
      collectionId: collections.product,
    });
    await people.priya.delete(`/api/v1/files/${file.id}`).expect(403);
    await people.tunde.delete(`/api/v1/files/${file.id}`).expect(204);
    expect(await titles(people.tunde)).not.toContain('Old memo');
    const trash = (await people.tunde.get('/api/v1/files?trash=true').expect(200)).body
      .items as FileRow[];
    const trashed = trash.find((f) => f.id === file.id)!;
    expect(trashed.deletedAt).toBeTruthy();
    expect(new Date(trashed.purgeAt!).getTime() - new Date(trashed.deletedAt!).getTime()).toBe(
      30 * 86_400_000,
    );
    await people.tunde.post(`/api/v1/files/${file.id}/restore`).expect(200);
    expect(await titles(people.tunde)).toContain('Old memo');

    // Someone else's file in an open collection: Kwame's? Tunde edits it but can't destroy it.
    const other = await upload(people.kwame, 'Shared memo.md', 'x', {
      collectionId: collections.product,
    });
    await people.tunde.delete(`/api/v1/files/${other.id}/permanent`).expect(403);

    const storage = t.app.get(StorageService);
    const key = (await db.file.findUniqueOrThrow({ where: { id: file.id } })).storageKey;
    await people.tunde.delete(`/api/v1/files/${file.id}/permanent`).expect(204);
    await expect(storage.head(key)).rejects.toThrow();
    await people.tunde.get(`/api/v1/files/${file.id}`).expect(404);
  });

  it('retries only failed files', async () => {
    const file = await upload(people.tunde, 'Broken.pdf', '%PDF', {
      collectionId: collections.product,
    });
    await people.tunde.post(`/api/v1/files/${file.id}/retry`).expect(409);
    await db.file.update({
      where: { id: file.id },
      data: { status: 'FAILED', error: 'extract_failed' },
    });
    const before = t.queue.sent.length;
    const retried = await people.tunde.post(`/api/v1/files/${file.id}/retry`).expect(200);
    expect(retried.body).toMatchObject({ status: 'uploaded', error: null });
    expect(t.queue.sent.length).toBe(before + 1);
    await people.priya.post(`/api/v1/files/${file.id}/retry`).expect(403);
  });

  it('hands out short-lived download links and audits downloads, not plays', async () => {
    const file = await upload(people.tunde, 'Standup.webm', Buffer.from('fake audio bytes'));
    const link = await people.priya.get(`/api/v1/files/${file.id}/download`).expect(200);
    expect(await (await fetch(link.body.url)).text()).toBe('fake audio bytes');
    await people.priya.get(`/api/v1/files/${file.id}/download?inline=true`).expect(200);
    const downloads = (await people.ada.get('/api/v1/audit').expect(200)).body.entries.filter(
      (e: { action: string; target: { id: string } }) =>
        e.action === 'file.downloaded' && e.target.id === file.id,
    );
    expect(downloads).toHaveLength(1);
  });

  it('pages with a cursor and filters', async () => {
    const first = await people.ada.get('/api/v1/files?limit=2&sort=name').expect(200);
    expect(first.body.items).toHaveLength(2);
    const next = await people.ada
      .get(`/api/v1/files?limit=2&sort=name&cursor=${first.body.nextCursor}`)
      .expect(200);
    const all = (await people.ada.get('/api/v1/files?sort=name&limit=100').expect(200)).body.items;
    expect([...first.body.items, ...next.body.items].map((f: FileRow) => f.id)).toEqual(
      all.slice(0, 4).map((f: FileRow) => f.id),
    );
    const audio = (await people.ada.get('/api/v1/files?kind=audio').expect(200)).body.items;
    expect(audio.every((f: { kind: string }) => f.kind === 'audio')).toBe(true);
    await people.ada.get('/api/v1/files?cursor=garbage').expect(400);
  });

  it('trashes a deleted collection’s files, unfiled, out of everyone else’s sight', async () => {
    const temp = (await people.tunde.post('/api/v1/collections', { name: 'Temp' }).expect(201)).body
      .id;
    const file = await upload(people.tunde, 'Temp file.md', 'x', { collectionId: temp });
    await people.tunde.delete(`/api/v1/collections/${temp}`).expect(204);
    const row = await db.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.collectionId).toBeNull();
    expect(row.deletedAt).not.toBeNull();
    const priyaTrash = (await people.priya.get('/api/v1/files?trash=true').expect(200)).body.items;
    expect(priyaTrash.map((f: FileRow) => f.id)).not.toContain(file.id);
    const tundeTrash = (await people.tunde.get('/api/v1/files?trash=true').expect(200)).body.items;
    expect(tundeTrash.map((f: FileRow) => f.id)).toContain(file.id);
  });

  it('sends live events only to people who can see the file', async () => {
    const hub = t.app.get(EventsHub);
    const listen = (who: 'tunde' | 'kwame', role: 'member' | 'admin') => {
      const events: MessageEvent[] = [];
      const auth = {
        user: { id: '', email: '', name: '', emailVerified: true, image: null },
        sessionId: 's',
        workspace: { id: workspaceId, role },
        ip: null,
      } satisfies RequestAuth;
      return { events, auth, who };
    };
    const members = await db.membership.findMany({ include: { user: true } });
    const userOf = (email: string) => members.find((m) => m.user.email === email)!.userId;
    const tunde = listen('tunde', 'member');
    tunde.auth.user.id = userOf('tunde@files.example');
    const kwame = listen('kwame', 'admin');
    kwame.auth.user.id = userOf('kwame@files.example');
    const subs = [tunde, kwame].map((l) => hub.connect(l.auth).subscribe((e) => l.events.push(e)));
    await new Promise((r) => setTimeout(r, 300));

    await upload(people.kwame, 'Secret.md', 'x', { collectionId: collections.board });
    const open = await upload(people.kwame, 'Open.md', 'x', { collectionId: collections.product });
    await new Promise((r) => setTimeout(r, 500));
    subs.forEach((s) => s.unsubscribe());

    const ids = (l: { events: MessageEvent[] }) =>
      l.events.filter((e) => e.type === 'file').map((e) => (e.data as { fileId: string }).fileId);
    expect(ids(kwame)).toHaveLength(2);
    expect(ids(tunde)).toEqual([open.id]);
    const event = tunde.events.find((e) => e.type === 'file')!.data as Record<string, unknown>;
    expect(event).toMatchObject({ status: 'UPLOADED', change: 'status' });
    expect(event).not.toHaveProperty('collectionId');
    expect(hub.listeners(workspaceId)).toBe(0);
  });
});
