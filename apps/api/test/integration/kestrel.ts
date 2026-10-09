/**
 * A small fictional workspace for Phase 5's tests (retrieval, search, Ask): Kestrel Labs, with
 * Ada (owner), Tunde (member, granted the restricted Board collection), Priya (viewer) and Kofi
 * (member, no grant), a Product and a restricted Board collection, and passages seeded straight
 * into chunks with vectors in a tiny embedding space whose meanings are known exactly.
 */
import type { EmbeddingProvider } from '@sotto/ai';
import {
  createPrismaClient,
  ensureEmbeddingIndex,
  writeEmbeddings,
  type PrismaClient,
  type Role,
  type Sensitivity,
} from '@sotto/db';
import { AiService } from '../../src/ask/ai.service.js';
import { Person, bootApp, type TestApp } from './harness.js';

/** Four meanings plus "none of these": a word maps to its meaning, a text to their sum. */
const MEANINGS: Record<string, number> = {
  ...Object.fromEntries(
    'money cash runway burn revenue budget funds months'.split(' ').map((w) => [w, 0]),
  ),
  ...Object.fromEntries('travel flights trip visit visits field'.split(' ').map((w) => [w, 1])),
  ...Object.fromEntries('security encrypted keys tls safe'.split(' ').map((w) => [w, 2])),
  ...Object.fromEntries('people hiring engineers designer recruit'.split(' ').map((w) => [w, 3])),
};

export const CONCEPT_MODEL = 'test:concepts';
export const CONCEPT_DIMS = 5;

export function embedConcepts(text: string): number[] {
  const v = new Array<number>(CONCEPT_DIMS).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    const i = MEANINGS[word];
    if (i !== undefined) v[i]! += 1;
  }
  const norm = Math.hypot(...v);
  return norm ? v.map((x) => x / norm) : [0, 0, 0, 0, 1];
}

export const conceptEmbedder: EmbeddingProvider = {
  id: 'test',
  model: 'concepts',
  label: 'Test concepts',
  capability: 'embedding',
  dataLocation: 'IN_CLUSTER',
  dimensions: CONCEPT_DIMS,
  embed: async (texts) => texts.map(embedConcepts),
};

/** Points the api's searches at the concept space and makes it the serving index. */
export async function useConcepts(t: TestApp, db: PrismaClient): Promise<AiService> {
  const ai = t.app.get(AiService);
  (ai as { embeddings: EmbeddingProvider }).embeddings = conceptEmbedder;
  await ensureEmbeddingIndex(db, CONCEPT_MODEL, CONCEPT_DIMS);
  ai.resetServing();
  return ai;
}

export type Who = 'ada' | 'tunde' | 'priya' | 'kofi';
export const ROLES: Record<Who, Role> = {
  ada: 'owner',
  tunde: 'member',
  priya: 'viewer',
  kofi: 'member',
};

export interface SeedInput {
  key: string;
  title: string;
  texts: string[];
  collection?: 'product' | 'board' | null;
  kind?: 'DOCUMENT' | 'AUDIO' | 'NOTE';
  sensitivity?: Sensitivity;
  status?: 'READY' | 'INDEXING';
  deleted?: boolean;
  workspace?: string;
}

export class Kestrel {
  t!: TestApp;
  db!: PrismaClient;
  workspaceId = '';
  readonly people = {} as Record<Who, Person>;
  readonly ids = {} as Record<Who, string>;
  readonly collections = {} as Record<'product' | 'board', string>;
  readonly files: Record<string, string> = {};

  constructor(private readonly domain: string) {}

  async start(): Promise<this> {
    this.t = await bootApp();
    this.db = createPrismaClient(this.t.databaseUrl);
    await useConcepts(this.t, this.db);
    const ada = (this.people.ada = new Person(this.t, `ada@${this.domain}`));
    await ada.signIn();
    this.workspaceId = (
      await ada.post('/api/v1/workspaces', { name: 'Kestrel' }).expect(201)
    ).body.id;
    for (const who of ['tunde', 'priya', 'kofi'] as const) {
      const email = `${who}@${this.domain}`;
      const invite = await ada.post('/api/v1/invites', { email, role: ROLES[who] }).expect(201);
      this.people[who] = new Person(this.t, email);
      await this.people[who].signIn();
      await this.people[who].post(`/api/v1/invites/${invite.body.id}/accept`).expect(200);
      await this.people[who].refresh();
    }
    for (const who of Object.keys(this.people) as Who[]) {
      this.ids[who] = (
        await this.db.user.findUniqueOrThrow({ where: { email: this.people[who].email } })
      ).id;
    }
    this.collections.product = (
      await ada.post('/api/v1/collections', { name: 'Product' }).expect(201)
    ).body.id;
    this.collections.board = (
      await ada.post('/api/v1/collections', { name: 'Board', restricted: true }).expect(201)
    ).body.id;
    await this.db.collectionPermission.create({
      data: {
        workspaceId: this.workspaceId,
        collectionId: this.collections.board,
        userId: this.ids.tunde,
        access: 'VIEW',
      },
    });
    return this;
  }

  viewer(who: Who) {
    return { userId: this.ids[who], role: ROLES[who], workspaceId: this.workspaceId };
  }

  /** A READY file with one chunk per text (a page each, or a minute each for recordings). */
  async seed(input: SeedInput): Promise<string> {
    const ws = input.workspace ?? this.workspaceId;
    const audio = input.kind === 'AUDIO';
    const file = await this.db.file.create({
      data: {
        workspaceId: ws,
        collectionId: input.collection ? this.collections[input.collection] : null,
        ownerId: this.ids.ada,
        kind: input.kind ?? 'DOCUMENT',
        title: input.title,
        status: input.status ?? 'READY',
        sensitivity: input.sensitivity ?? 'INTERNAL',
        storageKey: `files/${ws}/${input.key}/original`,
        mime: audio ? 'audio/webm' : 'text/markdown',
        sizeBytes: 100n,
        durationMs: audio ? input.texts.length * 60_000 : null,
        deletedAt: input.deleted ? new Date() : null,
      },
    });
    this.files[input.key] = file.id;
    const chunks = [];
    for (const [idx, text] of input.texts.entries()) {
      chunks.push(
        await this.db.chunk.create({
          data: {
            workspaceId: ws,
            fileId: file.id,
            collectionId: file.collectionId,
            sensitivity: file.sensitivity,
            idx,
            text,
            tokenCount: Math.ceil(text.length / 4),
            page: audio ? null : idx + 1,
            startMs: audio ? idx * 60_000 : null,
            endMs: audio ? idx * 60_000 + 30_000 : null,
          },
        }),
      );
    }
    await writeEmbeddings(
      this.db,
      ws,
      CONCEPT_MODEL,
      CONCEPT_DIMS,
      chunks.map((c) => ({ chunkId: c.id, vector: embedConcepts(c.text) })),
    );
    return file.id;
  }

  /** The usual library: memos, a confidential and a restricted file, a meeting, and decoys. */
  async seedLibrary(otherWorkspaceId?: string): Promise<void> {
    await this.seed({
      key: 'roadmap',
      title: 'Q4 roadmap memo',
      collection: 'product',
      texts: [
        'This quarter we focus on answers with citations and meeting notes.',
        'Onboarding a ten person team in one afternoon.',
      ],
    });
    await this.seed({
      key: 'pricing',
      title: 'Pricing review notes',
      collection: 'product',
      sensitivity: 'CONFIDENTIAL',
      texts: ['Decision: keep the free tier at three members and price Business per seat.'],
    });
    await this.seed({
      key: 'board',
      title: 'Board update',
      collection: 'board',
      sensitivity: 'RESTRICTED',
      texts: ['Runway is 21 months at the current burn. Budget of 40,000 pounds for the launch.'],
    });
    await this.seed({
      key: 'security',
      title: 'Security answers',
      collection: null,
      texts: ['Files are encrypted at rest and in transit with TLS.'],
    });
    await this.seed({
      key: 'weekly',
      title: 'Weekly product sync',
      collection: 'product',
      kind: 'AUDIO',
      texts: ['Offline recording is a launch requirement.', 'Field visits need it most.'],
    });
    await this.seed({
      key: 'trashed',
      title: 'Old pricing draft',
      collection: 'product',
      deleted: true,
      texts: ['Pricing draft: Business per seat at a different price.'],
    });
    await this.seed({
      key: 'processing',
      title: 'Pricing workshop',
      collection: 'product',
      status: 'INDEXING',
      texts: ['Pricing workshop transcript still indexing.'],
    });
    if (otherWorkspaceId) {
      await this.seed({
        key: 'elsewhere',
        title: 'Another company',
        workspace: otherWorkspaceId,
        texts: ['Pricing for another company entirely. Runway and burn.'],
      });
    }
  }

  async stop(): Promise<void> {
    await this.db?.$disconnect();
    await this.t?.close();
  }
}
