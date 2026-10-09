import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/infra.module.js';
import { withoutStorage } from './harness.js';
import { Kestrel } from './kestrel.js';

/** Notes: written in Sotto, stored as their original, indexed by the normal pipeline. */
describe.skipIf(withoutStorage)('notes', () => {
  const k = new Kestrel('notes.example');
  let noteId = '';

  beforeAll(async () => {
    await fetch(`${process.env.TEST_S3_ENDPOINT}/${process.env.TEST_S3_BUCKET ?? 'sotto-test'}`, {
      method: 'PUT',
    }).catch(() => undefined);
    await k.start();
  });
  afterAll(() => k.stop());

  it('writes a note: a NOTE file, its text stored, queued for indexing, audited', async () => {
    const res = await k.people.tunde
      .post('/api/v1/notes', {
        body: '# Launch risks\nConnectivity on field visits.',
        collectionId: k.collections.product,
      })
      .expect(201);
    noteId = res.body.file.id;
    expect(res.body).toMatchObject({
      body: '# Launch risks\nConnectivity on field visits.',
      file: {
        kind: 'note',
        source: 'written',
        title: 'Launch risks',
        status: 'uploaded',
        mime: 'text/markdown',
        access: 'edit',
        collection: { id: k.collections.product },
      },
    });
    const job = k.t.queue.sent.at(-1)!;
    expect(job).toMatchObject({
      queue: 'file.uploaded',
      message: { fileId: noteId, kind: 'NOTE', mime: 'text/markdown' },
    });
    const storage = k.t.app.get(StorageService);
    const file = await k.db.file.findUniqueOrThrow({ where: { id: noteId } });
    const stream = await storage.getStream(file.storageKey);
    let text = '';
    for await (const part of stream) text += String(part);
    expect(text).toBe('# Launch risks\nConnectivity on field visits.');
    const audit = await k.db.auditLog.findFirstOrThrow({ where: { action: 'note.created' } });
    expect(audit).toMatchObject({ targetId: noteId, meta: { name: 'Launch risks' } });
  });

  it('lets anyone who can open it read it, and nobody else', async () => {
    const read = await k.people.priya.get(`/api/v1/notes/${noteId}`).expect(200);
    expect(read.body.body).toContain('Connectivity');
    const secret = await k.people.ada
      .post('/api/v1/notes', { body: 'Board only', collectionId: k.collections.board })
      .expect(201);
    await k.people.priya.get(`/api/v1/notes/${secret.body.file.id}`).expect(404);
    await k.people.kofi.get(`/api/v1/notes/${secret.body.file.id}`).expect(404);
  });

  it('edits the text and indexes it again; a title alone needs no indexing', async () => {
    const before = k.t.queue.sent.length;
    const res = await k.people.tunde
      .patch(`/api/v1/notes/${noteId}`, { body: '# Launch risks\nPricing in naira.' })
      .expect(200);
    expect(res.body).toMatchObject({
      body: '# Launch risks\nPricing in naira.',
      file: { status: 'uploaded' },
    });
    expect(k.t.queue.sent.length).toBe(before + 1);
    const renamed = await k.people.tunde
      .patch(`/api/v1/notes/${noteId}`, { title: 'Lagos launch risks' })
      .expect(200);
    expect(renamed.body.file.title).toBe('Lagos launch risks');
    expect(k.t.queue.sent.length).toBe(before + 1);
    expect(await k.db.auditLog.count({ where: { action: 'note.edited' } })).toBe(2);
  });

  it('refuses viewers, empty notes, and collections you can only view', async () => {
    await k.people.priya.post('/api/v1/notes', { body: 'Hello' }).expect(403);
    await k.people.priya.patch(`/api/v1/notes/${noteId}`, { body: 'Changed' }).expect(403);
    await k.people.tunde.post('/api/v1/notes', { body: '   ' }).expect(400);
    await k.people.tunde.patch(`/api/v1/notes/${noteId}`, {}).expect(400);
    await k.people.tunde
      .post('/api/v1/notes', { body: 'Board note', collectionId: k.collections.board })
      .expect(403);
  });

  it('keeps unfiled notes editable by their writer and admins only', async () => {
    const mine = await k.people.kofi.post('/api/v1/notes', { body: 'Kofi’s note' }).expect(201);
    await k.people.tunde
      .patch(`/api/v1/notes/${mine.body.file.id}`, { body: 'Mine now' })
      .expect(403);
    await k.people.ada.patch(`/api/v1/notes/${mine.body.file.id}`, { body: 'Tidied' }).expect(200);
  });

  it('edits only notes', async () => {
    const id = await k.seed({ key: 'memo', title: 'A memo', texts: ['Text'] });
    await k.people.ada.patch(`/api/v1/notes/${id}`, { body: 'x' }).expect(409);
    await k.people.ada.get(`/api/v1/notes/${id}`).expect(404);
  });
});
