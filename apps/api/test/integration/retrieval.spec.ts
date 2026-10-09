import type { EmbeddingProvider } from '@sotto/ai';
import {
  createPrismaClient,
  ensureEmbeddingIndex,
  writeEmbeddings,
  type PrismaClient,
  type Role,
  type Sensitivity,
} from '@sotto/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiService } from '../../src/ask/ai.service.js';
import { RetrievalService } from '../../src/ask/retrieval.service.js';
import type { AskScope } from '../../src/ask/scope.js';
import { Person, bootApp, withDatabase, type TestApp } from './harness.js';

/**
 * A tiny embedding space with four meanings (plus "none of these"), so the semantic half of
 * hybrid search can be tested exactly: a word maps to its meaning, a text to the normalised sum
 * of its words.
 */
const MEANINGS: Record<string, number> = {
  money: 0,
  cash: 0,
  runway: 0,
  burn: 0,
  revenue: 0,
  budget: 0,
  funds: 0,
  months: 0,
  travel: 1,
  flights: 1,
  trip: 1,
  visit: 1,
  field: 1,
  security: 2,
  encrypted: 2,
  keys: 2,
  tls: 2,
  safe: 2,
  people: 3,
  hiring: 3,
  engineers: 3,
  designer: 3,
  recruit: 3,
};
function embedConcepts(text: string): number[] {
  const v = [0, 0, 0, 0, 0];
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    const i = MEANINGS[word];
    if (i !== undefined) v[i]! += 1;
  }
  const norm = Math.hypot(...v);
  return norm ? v.map((x) => x / norm) : [0, 0, 0, 0, 1];
}
const conceptEmbedder: EmbeddingProvider = {
  id: 'test',
  model: 'concepts',
  label: 'Test concepts',
  capability: 'embedding',
  dataLocation: 'IN_CLUSTER',
  dimensions: 5,
  embed: async (texts) => texts.map(embedConcepts),
};

/**
 * Hybrid retrieval against real Postgres full-text search and pgvector. Ada owns the workspace,
 * Tunde is a member with a grant on the board, Priya a viewer with none, Kofi a member without
 * one. A second workspace holds a passage nobody here may ever see.
 */
describe.skipIf(withDatabase)('retrieval', () => {
  let t: TestApp;
  let db: PrismaClient;
  let retrieval: RetrievalService;
  let workspaceId: string;
  let otherWorkspaceId: string;
  const people = {} as Record<'ada' | 'tunde' | 'priya' | 'kofi', Person>;
  const ids = {} as Record<'ada' | 'tunde' | 'priya' | 'kofi', string>;
  const collections = {} as Record<'product' | 'board', string>;
  const files: Record<string, string> = {};

  const viewer = (who: keyof typeof people, role: Role) => ({
    userId: ids[who],
    role,
    workspaceId,
  });

  /** A READY file with one chunk per text, embedded in the concept space. */
  async function seed(input: {
    key: string;
    title: string;
    texts: string[];
    collection?: 'product' | 'board' | null;
    kind?: 'DOCUMENT' | 'AUDIO' | 'NOTE';
    sensitivity?: Sensitivity;
    status?: 'READY' | 'INDEXING';
    deleted?: boolean;
    workspace?: string;
  }) {
    const ws = input.workspace ?? workspaceId;
    const file = await db.file.create({
      data: {
        workspaceId: ws,
        collectionId: input.collection ? collections[input.collection] : null,
        ownerId: ids.ada,
        kind: input.kind ?? 'DOCUMENT',
        title: input.title,
        status: input.status ?? 'READY',
        sensitivity: input.sensitivity ?? 'INTERNAL',
        storageKey: `files/${ws}/${input.key}/original`,
        mime: input.kind === 'AUDIO' ? 'audio/webm' : 'text/markdown',
        sizeBytes: 100n,
        deletedAt: input.deleted ? new Date() : null,
      },
    });
    files[input.key] = file.id;
    const chunks = [];
    for (const [idx, text] of input.texts.entries()) {
      chunks.push(
        await db.chunk.create({
          data: {
            workspaceId: ws,
            fileId: file.id,
            collectionId: file.collectionId,
            sensitivity: file.sensitivity,
            idx,
            text,
            tokenCount: text.length / 4,
            page: input.kind === 'AUDIO' ? null : idx + 1,
            startMs: input.kind === 'AUDIO' ? idx * 60_000 : null,
            endMs: input.kind === 'AUDIO' ? idx * 60_000 + 30_000 : null,
          },
        }),
      );
    }
    await writeEmbeddings(
      db,
      ws,
      'test:concepts',
      5,
      chunks.map((c) => ({ chunkId: c.id, vector: embedConcepts(c.text) })),
    );
    return file.id;
  }

  const search = (who: keyof typeof people, role: Role, question: string, extra = {}) =>
    retrieval.retrieve({ viewer: viewer(who, role), question, scope: {}, ...extra });
  const titles = (r: { passages: { title: string }[] }) => [
    ...new Set(r.passages.map((p) => p.title)),
  ];

  beforeAll(async () => {
    t = await bootApp();
    db = createPrismaClient(t.databaseUrl);
    retrieval = t.app.get(RetrievalService);
    // Searches embed with the concept space, which the index below serves.
    const ai = t.app.get(AiService);
    (ai as { embeddings: EmbeddingProvider }).embeddings = conceptEmbedder;
    await ensureEmbeddingIndex(db, 'test:concepts', 5);
    ai.resetServing();

    people.ada = new Person(t, 'ada@retrieval.example');
    await people.ada.signIn();
    workspaceId = (await people.ada.post('/api/v1/workspaces', { name: 'Kestrel' }).expect(201))
      .body.id;
    for (const [key, role] of [
      ['tunde', 'member'],
      ['priya', 'viewer'],
      ['kofi', 'member'],
    ] as const) {
      const email = `${key}@retrieval.example`;
      const invite = await people.ada.post('/api/v1/invites', { email, role }).expect(201);
      people[key] = new Person(t, email);
      await people[key].signIn();
      await people[key].post(`/api/v1/invites/${invite.body.id}/accept`).expect(200);
    }
    for (const key of Object.keys(people) as (keyof typeof people)[]) {
      ids[key] = (await db.user.findUniqueOrThrow({ where: { email: people[key].email } })).id;
    }
    collections.product = (
      await people.ada.post('/api/v1/collections', { name: 'Product' }).expect(201)
    ).body.id;
    collections.board = (
      await people.ada.post('/api/v1/collections', { name: 'Board', restricted: true }).expect(201)
    ).body.id;
    await db.collectionPermission.create({
      data: { workspaceId, collectionId: collections.board, userId: ids.tunde, access: 'VIEW' },
    });
    otherWorkspaceId = (
      await people.ada.post('/api/v1/workspaces', { name: 'Elsewhere' }).expect(201)
    ).body.id;
    await people.ada.post(`/api/v1/workspaces/${workspaceId}/activate`).expect(200);

    await seed({
      key: 'roadmap',
      title: 'Q4 roadmap memo',
      collection: 'product',
      texts: [
        'This quarter we focus on answers with citations and meeting notes.',
        'Onboarding a ten person team in one afternoon.',
      ],
    });
    await seed({
      key: 'pricing',
      title: 'Pricing review notes',
      collection: 'product',
      sensitivity: 'CONFIDENTIAL',
      texts: ['Decision: keep the free tier at three members and price Business per seat.'],
    });
    await seed({
      key: 'board',
      title: 'Board update',
      collection: 'board',
      sensitivity: 'RESTRICTED',
      texts: ['Runway is 21 months at the current burn. Budget of 40,000 pounds for the launch.'],
    });
    await seed({
      key: 'security',
      title: 'Security answers',
      collection: null,
      texts: ['Files are encrypted at rest and in transit with TLS.'],
    });
    await seed({
      key: 'weekly',
      title: 'Weekly product sync',
      collection: 'product',
      kind: 'AUDIO',
      texts: ['Offline recording is a launch requirement.', 'Field visits need it most.'],
    });
    await seed({
      key: 'trashed',
      title: 'Old pricing draft',
      collection: 'product',
      deleted: true,
      texts: ['Pricing draft: Business per seat at a different price.'],
    });
    await seed({
      key: 'processing',
      title: 'Pricing workshop',
      collection: 'product',
      status: 'INDEXING',
      texts: ['Pricing workshop transcript still indexing.'],
    });
    await seed({
      key: 'elsewhere',
      title: 'Another company',
      workspace: otherWorkspaceId,
      texts: ['Pricing for another company entirely. Runway and burn.'],
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
    await t?.close();
  });

  it('finds passages by keyword, ranked, with their page or time', async () => {
    const r = await search('ada', 'owner', 'What did we decide about pricing?');
    expect(r.mode).toBe('hybrid');
    expect(r.passages[0]).toMatchObject({
      title: 'Pricing review notes',
      page: 1,
      sensitivity: 'CONFIDENTIAL',
    });
    expect(r.passages[0]!.keywordRank).toBe(1);
    const meeting = await search('ada', 'owner', 'offline recording');
    expect(meeting.passages[0]).toMatchObject({
      title: 'Weekly product sync',
      kind: 'AUDIO',
      startMs: 0,
      endMs: 30_000,
      page: null,
    });
  });

  it('never returns trashed, unfinished or other workspaces’ files', async () => {
    const r = await search('ada', 'owner', 'pricing workshop draft another company');
    expect(titles(r)).not.toContain('Old pricing draft');
    expect(titles(r)).not.toContain('Pricing workshop');
    expect(titles(r)).not.toContain('Another company');
  });

  it('finds a passage by meaning when it shares no words with the question', async () => {
    const r = await search('ada', 'owner', 'How much cash do we have left?');
    expect(r.passages[0]).toMatchObject({ title: 'Board update', keywordRank: null });
    expect(r.passages[0]!.similarity).toBeGreaterThan(0.9);
    // Unrelated passages are near something, but not near enough to count.
    expect(titles(r)).toEqual(['Board update']);
  });

  it('ranks a passage both halves found above one only one found', async () => {
    const r = await search('ada', 'owner', 'encrypted security trip');
    expect(r.passages[0]!.title).toBe('Security answers');
    expect(r.passages[0]!.keywordRank).not.toBeNull();
    expect(r.passages[0]!.vectorRank).not.toBeNull();
  });

  it('keeps a restricted collection out of reach for everyone without a grant', async () => {
    const question = 'runway burn budget cash';
    expect(titles(await search('ada', 'owner', question))).toContain('Board update');
    expect(titles(await search('tunde', 'member', question))).toContain('Board update');
    expect(titles(await search('priya', 'viewer', question))).not.toContain('Board update');
    expect(titles(await search('kofi', 'member', question))).not.toContain('Board update');
    // Not even by meaning, and not in the hidden count either: it's not theirs to know about.
    const priya = await search('priya', 'viewer', question, { allowed: ['INTERNAL'] });
    expect(priya.passages).toEqual([]);
    expect(priya.hidden).toEqual({ restricted: 0, confidential: 0 });
  });

  it('narrows to a collection, picked files, documents or meetings', async () => {
    const question = 'pricing offline recording encrypted';
    const scoped = async (scope: AskScope) =>
      titles(await retrieval.retrieve({ viewer: viewer('ada', 'owner'), question, scope }));
    expect(await scoped({ collectionId: collections.product })).toEqual(
      expect.arrayContaining(['Pricing review notes', 'Weekly product sync']),
    );
    expect(await scoped({ collectionId: collections.product })).not.toContain('Security answers');
    expect(await scoped({ fileIds: [files.security!] })).toEqual(['Security answers']);
    expect(await scoped({ kind: 'meetings' })).toEqual(['Weekly product sync']);
    expect(await scoped({ kind: 'documents' })).not.toContain('Weekly product sync');
    // A scope can't widen access: Priya picking the board file still gets nothing from it.
    const picked = await retrieval.retrieve({
      viewer: viewer('priya', 'viewer'),
      question: 'runway burn',
      scope: { fileIds: [files.board!] },
    });
    expect(picked.passages).toEqual([]);
  });

  it('leaves out what the answering model may not read, and counts it', async () => {
    const r = await search('ada', 'owner', 'pricing runway burn cash', { allowed: ['INTERNAL'] });
    expect(r.passages.every((p) => p.sensitivity === 'INTERNAL')).toBe(true);
    expect(r.hidden).toEqual({ restricted: 1, confidential: 1 });
  });

  it('caps passages per file so an answer draws on several sources', async () => {
    const r = await search('ada', 'owner', 'offline recording field visits pricing', {
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
      const r = await search('ada', 'owner', 'pricing');
      expect(r.mode).toBe('keyword');
      expect(r.passages[0]!.title).toBe('Pricing review notes');
      expect((await search('ada', 'owner', 'How much cash is left')).passages).toEqual([]);
    } finally {
      (ai as { embeddings: EmbeddingProvider }).embeddings = conceptEmbedder;
    }
  });

  it('returns nothing for a question with no searchable words and no index', async () => {
    const ai = t.app.get(AiService);
    const original = ai.queryVector.bind(ai);
    ai.queryVector = async () => null;
    try {
      const r = await search('ada', 'owner', 'what is the?');
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
