import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withDatabase } from './harness.js';
import { Kestrel, type Who } from './kestrel.js';

interface Results {
  mode: string;
  files: { file: { id: string; title: string; kind: string }; match: string }[];
  passages: {
    file: { id: string; title: string; kind: string };
    page: number | null;
    snippet: { text: string; highlights: [number, number][] };
  }[];
  moments: { file: { title: string }; startMs: number; endMs: number }[];
}

/** GET /search per role, in the Kestrel fixture. */
describe.skipIf(withDatabase)('search', () => {
  const k = new Kestrel('search.example');
  const search = async (who: Who, q: string, extra = '') =>
    (await k.people[who].get(`/api/v1/search?q=${encodeURIComponent(q)}${extra}`).expect(200))
      .body as Results;
  const everything = (r: Results) => [
    ...r.files.map((f) => f.file.title),
    ...r.passages.map((p) => p.file.title),
    ...r.moments.map((m) => m.file.title),
  ];

  beforeAll(async () => {
    await k.start();
    await k.seedLibrary();
  });
  afterAll(() => k.stop());

  it('returns files, passages with highlighted words, and meeting moments', async () => {
    const r = await search('ada', 'pricing offline recording');
    expect(r.mode).toBe('hybrid');
    expect(r.files[0]).toMatchObject({ file: { title: 'Pricing review notes' }, match: 'title' });
    const pricing = r.passages.find((p) => p.file.title === 'Pricing review notes')!;
    expect(pricing).toMatchObject({ page: 1, file: { kind: 'document' } });
    const words = pricing.snippet.highlights.map(([a, b]) => pricing.snippet.text.slice(a, b));
    expect(words).toEqual(['price']);
    expect(r.moments[0]).toMatchObject({
      file: { title: 'Weekly product sync' },
      startMs: 0,
      endMs: 30_000,
    });
    // Trashed and unfinished files stay out, even by title.
    expect(everything(r)).not.toContain('Old pricing draft');
  });

  it('finds files by what they mean as well as by title', async () => {
    const r = await search('ada', 'how much cash is left');
    expect(r.files).toEqual([
      expect.objectContaining({
        file: expect.objectContaining({ title: 'Board update' }),
        match: 'content',
      }),
    ]);
  });

  it('never shows anything from a collection the person can’t open', async () => {
    for (const who of ['priya', 'kofi'] as const) {
      const r = await search(who, 'board runway burn cash budget');
      expect(everything(r)).not.toContain('Board update');
    }
    expect(everything(await search('tunde', 'board runway'))).toContain('Board update');
  });

  it('narrows to a collection or to meetings', async () => {
    const product = await search(
      'ada',
      'encrypted pricing',
      `&collection=${k.collections.product}`,
    );
    expect(everything(product)).not.toContain('Security answers');
    const meetings = await search('ada', 'pricing offline', '&kind=meetings');
    expect(meetings.passages).toEqual([]);
    expect(everything(meetings)).toEqual(expect.arrayContaining(['Weekly product sync']));
    expect(everything(meetings)).not.toContain('Pricing review notes');
  });

  it('refuses an empty search and anyone signed out', async () => {
    await k.people.ada.get('/api/v1/search?q=%20').expect(400);
    const { default: request } = await import('supertest');
    await request(k.t.app.getHttpServer()).get('/api/v1/search?q=pricing').expect(401);
  });
});
