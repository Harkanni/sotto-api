import type { EmbeddingProvider } from '@sotto/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiService } from '../../src/ask/ai.service.js';
import { RetrievalService } from '../../src/ask/retrieval.service.js';
import type { AskScope } from '../../src/ask/scope.js';
import { withDatabase } from './harness.js';
import { Kestrel, type Who, conceptEmbedder } from './kestrel.js';

/**
 * Hybrid retrieval against real Postgres full-text search and pgvector, in the Kestrel fixture
 * (kestrel.ts). A second workspace holds a passage nobody here may ever see.
 */
describe.skipIf(withDatabase)('retrieval', () => {
  const k = new Kestrel('retrieval.example');
  let retrieval: RetrievalService;
  let t: Kestrel['t'];
  let files: Kestrel['files'];
  let collections: Kestrel['collections'];

  const viewer = (who: Who) => k.viewer(who);
  const search = (who: Who, question: string, extra = {}) =>
    retrieval.retrieve({ viewer: viewer(who), question, scope: {}, ...extra });
  const titles = (r: { passages: { title: string }[] }) => [
    ...new Set(r.passages.map((p) => p.title)),
  ];

  beforeAll(async () => {
    await k.start();
    ({ t, files, collections } = k);
    retrieval = t.app.get(RetrievalService);
    const other = (await k.people.ada.post('/api/v1/workspaces', { name: 'Elsewhere' }).expect(201))
      .body.id;
    await k.people.ada.post(`/api/v1/workspaces/${k.workspaceId}/activate`).expect(200);
    await k.seedLibrary(other);
  });

  afterAll(() => k.stop());

  it('finds passages by keyword, ranked, with their page or time', async () => {
    const r = await search('ada', 'What did we decide about pricing?');
    expect(r.mode).toBe('hybrid');
    expect(r.passages[0]).toMatchObject({
      title: 'Pricing review notes',
      page: 1,
      sensitivity: 'CONFIDENTIAL',
    });
    expect(r.passages[0]!.keywordRank).toBe(1);
    const meeting = await search('ada', 'offline recording');
    expect(meeting.passages[0]).toMatchObject({
      title: 'Weekly product sync',
      kind: 'AUDIO',
      startMs: 0,
      endMs: 30_000,
      page: null,
    });
  });

  it('never returns trashed, unfinished or other workspaces’ files', async () => {
    const r = await search('ada', 'pricing workshop draft another company');
    expect(titles(r)).not.toContain('Old pricing draft');
    expect(titles(r)).not.toContain('Pricing workshop');
    expect(titles(r)).not.toContain('Another company');
  });

  it('finds a passage by meaning when it shares no words with the question', async () => {
    const r = await search('ada', 'How much cash do we have left?');
    expect(r.passages[0]).toMatchObject({ title: 'Board update', keywordRank: null });
    expect(r.passages[0]!.similarity).toBeGreaterThan(0.9);
    // Unrelated passages are near something, but not near enough to count.
    expect(titles(r)).toEqual(['Board update']);
  });

  it('ranks a passage both halves found above one only one found', async () => {
    const r = await search('ada', 'encrypted security trip');
    expect(r.passages[0]!.title).toBe('Security answers');
    expect(r.passages[0]!.keywordRank).not.toBeNull();
    expect(r.passages[0]!.vectorRank).not.toBeNull();
  });

  it('keeps a restricted collection out of reach for everyone without a grant', async () => {
    const question = 'runway burn budget cash';
    expect(titles(await search('ada', question))).toContain('Board update');
    expect(titles(await search('tunde', question))).toContain('Board update');
    expect(titles(await search('priya', question))).not.toContain('Board update');
    expect(titles(await search('kofi', question))).not.toContain('Board update');
    // Not even by meaning, and not in the hidden count either: it's not theirs to know about.
    const priya = await search('priya', question, { allowed: ['INTERNAL'] });
    expect(priya.passages).toEqual([]);
    expect(priya.hidden).toEqual({ restricted: 0, confidential: 0 });
  });

  it('narrows to a collection, picked files, documents or meetings', async () => {
    const question = 'pricing offline recording encrypted';
    const scoped = async (scope: AskScope) =>
      titles(await retrieval.retrieve({ viewer: viewer('ada'), question, scope }));
    expect(await scoped({ collectionId: collections.product })).toEqual(
      expect.arrayContaining(['Pricing review notes', 'Weekly product sync']),
    );
    expect(await scoped({ collectionId: collections.product })).not.toContain('Security answers');
    expect(await scoped({ fileIds: [files.security!] })).toEqual(['Security answers']);
    expect(await scoped({ kind: 'meetings' })).toEqual(['Weekly product sync']);
    expect(await scoped({ kind: 'documents' })).not.toContain('Weekly product sync');
    // A scope can't widen access: Priya picking the board file still gets nothing from it.
    const picked = await retrieval.retrieve({
      viewer: viewer('priya'),
      question: 'runway burn',
      scope: { fileIds: [files.board!] },
    });
    expect(picked.passages).toEqual([]);
  });

  it('leaves out what the answering model may not read, and counts it', async () => {
    const r = await search('ada', 'pricing runway burn cash', { allowed: ['INTERNAL'] });
    expect(r.passages.every((p) => p.sensitivity === 'INTERNAL')).toBe(true);
    expect(r.hidden).toEqual({ restricted: 1, confidential: 1 });
  });

  it('caps passages per file so an answer draws on several sources', async () => {
    const r = await search('ada', 'offline recording field visits pricing', {
      perFile: 1,
    });
    const perFile = new Map<string, number>();
    for (const p of r.passages) perFile.set(p.fileId, (perFile.get(p.fileId) ?? 0) + 1);
    expect(Math.max(...perFile.values())).toBe(1);
  });

  it('falls back to keywords, and says so, when the index uses another model', async () => {
    const ai = t.app.get(AiService);
    (ai as { embeddings: EmbeddingProvider }).embeddings = { ...conceptEmbedder, model: 'other' };
    try {
      const r = await search('ada', 'pricing');
      expect(r.mode).toBe('keyword');
      expect(r.passages[0]!.title).toBe('Pricing review notes');
      expect((await search('ada', 'How much cash is left')).passages).toEqual([]);
    } finally {
      (ai as { embeddings: EmbeddingProvider }).embeddings = conceptEmbedder;
    }
  });

  it('returns nothing for a question with no searchable words and no index', async () => {
    const ai = t.app.get(AiService);
    const original = ai.queryVector.bind(ai);
    ai.queryVector = async () => null;
    try {
      const r = await search('ada', 'what is the?');
      expect(r).toEqual({
        passages: [],
        hidden: { restricted: 0, confidential: 0 },
        mode: 'keyword',
      });
    } finally {
      ai.queryVector = original;
    }
  });
});
