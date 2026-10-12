import type { MessageEvent } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StorageService } from '../../src/infra.module.js';
import { LiveService, resumeAfter } from '../../src/live/live.service.js';
import { LiveTranscriber } from '../../src/live/transcriber.js';
import { withoutStorage } from './harness.js';
import { Kestrel, type Who } from './kestrel.js';
import { StandInTranscriber } from './stand-in-transcriber.js';

describe('resumeAfter', () => {
  it('reads a segment id and ignores anything else', () => {
    expect(resumeAfter('12.3')).toEqual({ seq: 12, idx: 3 });
    expect(resumeAfter(undefined)).toBeNull();
    expect(resumeAfter('12')).toBeNull();
    expect(resumeAfter('1.2; drop table')).toBeNull();
  });
});

/** Phase 7, M2: Listen mode's API. Tunde and Kofi are members; Priya a viewer. */
describe.skipIf(withoutStorage)('live sessions (Listen)', () => {
  const k = new Kestrel('live.example');
  const transcriber = new StandInTranscriber();
  /** `ms` of silence as 16 kHz mono PCM16 (32 bytes a millisecond). */
  const pcm = (ms: number) => Buffer.alloc(ms * 32);

  let live: LiveService;
  let storage: StorageService;

  beforeAll(async () => {
    await transcriber.start();
    process.env.TRANSCRIBER_URL = transcriber.url;
    await k.start();
    live = k.t.app.get(LiveService);
    storage = k.t.app.get(StorageService);
  });

  afterAll(async () => {
    await k.stop();
    await transcriber.stop();
  });

  const start = (who: Who, body: object = { inputs: ['mic'] }) =>
    k.people[who].post('/api/v1/live-sessions', body);
  const send = (who: Who, id: string, seq: number, audio: Buffer) =>
    k.people[who]
      .post(`/api/v1/live-sessions/${id}/audio?seq=${seq}`)
      .set('content-type', 'application/octet-stream')
      .send(audio);

  it('lets members start; viewers can’t', async () => {
    await start('priya').expect(403);
    const res = await start('tunde', { inputs: ['mic', 'tab'], title: 'Weekly sync' }).expect(201);
    expect(res.body).toMatchObject({
      source: 'listen',
      status: 'connecting',
      inputs: ['mic', 'tab'],
      nextSeq: 0,
      canControl: true,
      transcriber: { engine: 'stand-in', isMock: false },
      file: { kind: 'audio', source: 'live', status: 'uploading', title: 'Weekly sync' },
    });
    // It shows in the starter's Meetings while it happens, and nobody else's until it's saved
    // (a file still arriving belongs to whoever sends it, ADR 0016).
    const list = async (who: Who) =>
      (
        (await k.people[who].get('/api/v1/files?kind=audio').expect(200)).body.items as {
          id: string;
        }[]
      ).map((f) => f.id);
    expect(await list('tunde')).toContain(res.body.file.id);
    expect(await list('kofi')).not.toContain(res.body.file.id);
    expect(await list('ada')).not.toContain(res.body.file.id);
    await k.people.ada.get(`/api/v1/live-sessions/${res.body.id}`).expect(404);
  });

  it('takes numbered audio in order: a resend changes nothing, a gap is refused', async () => {
    const id = (await start('tunde').expect(201)).body.id as string;
    expect((await send('tunde', id, 0, pcm(4_000)).expect(200)).body).toEqual({
      accepted: true,
      nextSeq: 1,
      durationMs: 4_000,
    });
    expect((await send('tunde', id, 0, pcm(4_000)).expect(200)).body.accepted).toBe(false);
    const gap = await send('tunde', id, 2, pcm(4_000)).expect(409);
    expect(gap.body.error.code).toBe('CHUNK_GAP');
    expect((await send('tunde', id, 1, pcm(2_000)).expect(200)).body.durationMs).toBe(6_000);

    // Nobody else can even find it; odd-sized or oversized audio is refused.
    await send('kofi', id, 2, pcm(1_000)).expect(404);
    await send('tunde', id, 2, Buffer.alloc(33)).expect(400);
    await send('tunde', id, 2, pcm(16_000)).expect(413);
    await k.people.tunde
      .post(`/api/v1/live-sessions/${id}/audio?seq=2`)
      .set('content-type', 'application/json')
      .send({ a: 1 })
      .expect(415);

    await live.settled(id);
    const session = (await k.people.tunde.get(`/api/v1/live-sessions/${id}`).expect(200)).body;
    expect(session).toMatchObject({
      status: 'live',
      nextSeq: 2,
      durationMs: 6_000,
      canControl: true,
    });
  });

  it('transcribes each chunk in order, at its place in the call, and replays it to late viewers', async () => {
    const id = (await start('tunde').expect(201)).body.id as string;
    const before = transcriber.transcribed;
    for (const [seq, ms] of [4_000, 4_000, 4_000].entries()) {
      await send('tunde', id, seq, pcm(ms)).expect(200);
    }
    await live.settled(id);
    expect(transcriber.transcribed - before).toBe(3);
    const segments = await live.segments(k.workspaceId, id, null);
    expect(segments.map((s) => [s.id, s.startMs, s.endMs])).toEqual([
      ['0.0', 200, 3_800],
      ['1.0', 4_200, 7_800],
      ['2.0', 8_200, 11_800],
    ]);
    expect(segments[0]!.text).toMatch(/^Line \d+$/); // trimmed

    // A screen opening now (the starter's laptop) gets the session, then everything said so far;
    // resuming after a dropped connection skips what it had.
    const events = await collect(await live.stream(k.viewer('tunde'), id, undefined), 4);
    expect(events.map((e) => e.type)).toEqual(['session', 'segment', 'segment', 'segment']);
    expect(events.slice(1).map((e) => e.id)).toEqual(['0.0', '1.0', '2.0']);
    const resumed = await collect(await live.stream(k.viewer('tunde'), id, '0.0'), 3);
    expect(resumed.slice(1).map((e) => e.id)).toEqual(['1.0', '2.0']);
  });

  it('pushes new lines to every screen watching as they’re heard', async () => {
    const id = (await start('tunde').expect(201)).body.id as string;
    // The session, the session going live on the first chunk, then each line.
    const watching = collect(await live.stream(k.viewer('tunde'), id, undefined), 4);
    await send('tunde', id, 0, pcm(4_000)).expect(200);
    await send('tunde', id, 1, pcm(4_000)).expect(200);
    const events = await watching;
    await live.settled(id);
    expect(events[0]!.type).toBe('session');
    const statuses = events
      .filter((e) => e.type === 'session')
      .map((e) => (e.data as { status: string }).status);
    expect(statuses).toEqual(['connecting', 'live']);
    expect(events.filter((e) => e.type === 'segment').map((e) => e.id)).toEqual(['0.0', '1.0']);
  });

  it('keeps going when the transcriber fails a chunk, and says so', async () => {
    const id = (await start('tunde').expect(201)).body.id as string;
    transcriber.failNext = 1;
    await send('tunde', id, 0, pcm(4_000)).expect(200);
    await live.settled(id);
    expect((await k.people.tunde.get(`/api/v1/live-sessions/${id}`).expect(200)).body.error).toBe(
      'transcriber_failed',
    );
    await send('tunde', id, 1, pcm(4_000)).expect(200);
    await live.settled(id);
    const session = (await k.people.tunde.get(`/api/v1/live-sessions/${id}`).expect(200)).body;
    expect(session.error).toBeNull();
    expect((await live.segments(k.workspaceId, id, null)).map((s) => s.id)).toEqual(['1.0']);
  });

  it('never sends a Restricted capture to an engine outside the cluster', async () => {
    const id = (
      await start('ada', { inputs: ['mic'], collectionId: k.collections.board }).expect(201)
    ).body.id as string;
    // Restricted by label, too: either way the rule is the file's sensitivity.
    await k.db.file.updateMany({
      where: { liveSession: { id } },
      data: { sensitivity: 'RESTRICTED' },
    });
    // The engine moved outside a moment ago: the api's check sees it at once (no cached answer)…
    await k.t.app.get(LiveTranscriber).engine(); // warm the cache with IN_CLUSTER
    transcriber.dataLocation = 'THIRD_PARTY';
    const before = transcriber.transcribed;
    await send('ada', id, 0, pcm(4_000)).expect(200);
    await live.settled(id);
    expect(transcriber.transcribed).toBe(before);
    expect((await k.people.ada.get(`/api/v1/live-sessions/${id}`).expect(200)).body.error).toBe(
      'engine_outside',
    );
    // …and the request itself is marked, so the transcriber refuses too if it changes in between.
    const lie = vi
      .spyOn(k.t.app.get(LiveTranscriber), 'engine')
      .mockResolvedValue({ active: 'x', model: 'x', dataLocation: 'IN_CLUSTER', isMock: false });
    await send('ada', id, 1, pcm(4_000)).expect(200);
    await live.settled(id);
    lie.mockRestore();
    transcriber.dataLocation = 'IN_CLUSTER';
    const last = transcriber.received.filter((r) => r.path === '/v1/transcribe').at(-1)!;
    expect(last.inClusterOnly).toBe(true);
    expect(await live.segments(k.workspaceId, id, null)).toEqual([]);
    // An Internal capture doesn't ask.
    const open = (await start('tunde').expect(201)).body.id as string;
    await send('tunde', open, 0, pcm(4_000)).expect(200);
    await live.settled(open);
    expect(
      transcriber.received.filter((r) => r.path === '/v1/transcribe').at(-1)!.inClusterOnly,
    ).toBe(false);
  });

  it('keeps a live capture to the person listening until it’s saved, live list included', async () => {
    const id = (
      await start('ada', { inputs: ['mic'], collectionId: k.collections.board }).expect(201)
    ).body.id as string;
    const live_ = async (who: Who) =>
      (
        (await k.people[who].get('/api/v1/live-sessions').expect(200)).body.items as {
          id: string;
        }[]
      ).map((s) => s.id);
    expect(await live_('ada')).toContain(id);
    for (const who of ['tunde', 'kofi', 'priya'] as const) {
      await k.people[who].get(`/api/v1/live-sessions/${id}`).expect(404);
      await expect(live.stream(k.viewer(who), id, undefined)).rejects.toMatchObject({
        status: 404,
      });
      expect(await live_(who)).not.toContain(id);
    }
    // Starting one in a collection needs Edit: Kofi can't see Board, Tunde may only view it.
    await start('kofi', { inputs: ['mic'], collectionId: k.collections.board }).expect(404);
    await start('tunde', { inputs: ['mic'], collectionId: k.collections.board }).expect(403);
  });

  it('ends into a normal meeting: one WAV, queued for the pipeline, the pieces cleared', async () => {
    const res = await start('tunde').expect(201);
    const id = res.body.id as string;
    const fileId = res.body.file.id as string;
    await send('tunde', id, 0, pcm(4_000)).expect(200);
    await send('tunde', id, 1, pcm(1_500)).expect(200);
    await k.people.kofi.post(`/api/v1/live-sessions/${id}/end`).expect(404);

    const ended = (await k.people.tunde.post(`/api/v1/live-sessions/${id}/end`).expect(200)).body;
    expect(ended).toMatchObject({
      discarded: false,
      session: { status: 'ended', canControl: false, file: { status: 'uploaded' } },
    });
    const file = await k.db.file.findUniqueOrThrow({ where: { id: fileId } });
    expect(file.storageKey).toBe(`files/${k.workspaceId}/${fileId}/original.wav`);
    expect(Number(file.sizeBytes)).toBe(44 + 5_500 * 32);
    expect(file.durationMs).toBe(5_500);
    const wav = await storage.getBytes(file.storageKey);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(5_500 * 32);
    expect(k.t.queue.sent.at(-1)).toMatchObject({
      queue: 'file.uploaded',
      message: { fileId, kind: 'AUDIO', mime: 'audio/wav' },
    });
    await expect(storage.head(storage.keys.liveChunk(k.workspaceId, fileId, 0))).rejects.toThrow();
    const audit = await k.db.auditLog.findFirst({
      where: { action: 'file.recorded', targetId: fileId },
    });
    expect(audit?.actorId).toBe(k.ids.tunde);

    // Ending twice is fine; sending after the end isn't.
    await k.people.tunde.post(`/api/v1/live-sessions/${id}/end`).expect(200);
    expect((await send('tunde', id, 2, pcm(1_000)).expect(409)).body.error.code).toBe('LIVE_ENDED');
    // Saved, it's an ordinary meeting: everyone who can see unfiled files sees it.
    await k.people.kofi.get(`/api/v1/files/${fileId}`).expect(200);
    await k.people.kofi.get(`/api/v1/live-sessions/${id}`).expect(200);
  });

  it('removes the meeting when nothing was captured', async () => {
    const res = await start('tunde').expect(201);
    const ended = (
      await k.people.tunde.post(`/api/v1/live-sessions/${res.body.id}/end`).expect(200)
    ).body;
    expect(ended).toEqual({ discarded: true, session: null });
    expect(await k.db.file.findUnique({ where: { id: res.body.file.id } })).toBeNull();
  });

  it('ends a capture that went quiet ten minutes ago, as the system', async () => {
    const res = await start('tunde').expect(201);
    const id = res.body.id as string;
    await send('tunde', id, 0, pcm(2_000)).expect(200);
    await live.settled(id);
    expect(await live.sweep(new Date(Date.now() + 5 * 60_000))).toBe(0);
    expect(await live.sweep(new Date(Date.now() + 11 * 60_000))).toBeGreaterThanOrEqual(1);
    const session = await k.db.liveSession.findUniqueOrThrow({ where: { id } });
    expect(session.status).toBe('ENDED');
    const file = await k.db.file.findUniqueOrThrow({ where: { id: res.body.file.id } });
    expect(file.status).toBe('UPLOADED');
    const audit = await k.db.auditLog.findFirst({
      where: { action: 'file.recorded', targetId: file.id },
    });
    expect(audit?.actorId).toBeNull();
  });
});

/** The first `n` events of a stream, then unsubscribes. */
function collect(
  stream: import('rxjs').Observable<MessageEvent>,
  n: number,
  timeoutMs = 5_000,
): Promise<MessageEvent[]> {
  return new Promise((resolve, reject) => {
    const events: MessageEvent[] = [];
    const timer = setTimeout(
      () => reject(new Error(`only ${events.length} of ${n} events arrived`)),
      timeoutMs,
    );
    const sub = stream.subscribe({
      next: (event) => {
        if (event.type === 'ping') return;
        events.push(event);
        if (events.length === n) {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(events);
        }
      },
      error: (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}
