import { readFileSync } from 'node:fs';
import type { ChatChunk, ChatProvider } from '@sotto/ai';
import { describe, expect, it } from 'vitest';
import { TARGET_CHARS, chunkPages, chunkTranscript, sentences } from '../src/chunk.js';
import { ExtractError, extract, tidy } from '../src/extract.js';
import { basicInsights, clock, modelInsights, parseInsights } from '../src/insights.js';
import { makePdf } from './helpers.js';

describe('extract', () => {
  it('keeps PDF page numbers', async () => {
    const pdf = makePdf(['Roadmap overview', 'Pricing decisions', 'Hiring plan']);
    const out = await extract(new Uint8Array(pdf), 'application/pdf');
    expect(out.paged).toBe(true);
    expect(out.pages).toEqual([
      { page: 1, text: 'Roadmap overview' },
      { page: 2, text: 'Pricing decisions' },
      { page: 3, text: 'Hiring plan' },
    ]);
  });

  it('reads Word, text and Markdown as one flowing text', async () => {
    const docx = readFileSync(new URL('./fixtures/pricing.docx', import.meta.url));
    const word = await extract(
      new Uint8Array(docx),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(word.paged).toBe(false);
    expect(word.pages[0]!.text).toContain('Decision: keep the free tier');
    const md = await extract(
      new TextEncoder().encode('\uFEFF# Notes\r\n\r\n\r\nShip it.'),
      'text/markdown',
    );
    expect(md.pages).toEqual([{ page: 1, text: '# Notes\n\nShip it.' }]);
  });

  it('says why a document can’t be read', async () => {
    await expect(extract(new TextEncoder().encode('not a pdf'), 'application/pdf')).rejects.toEqual(
      new ExtractError('unreadable'),
    );
    await expect(extract(new Uint8Array(makePdf([''])), 'application/pdf')).rejects.toEqual(
      new ExtractError('no_text'),
    );
    await expect(extract(new Uint8Array([1]), 'image/png')).rejects.toEqual(
      new ExtractError('unsupported'),
    );
  });

  it('tidies whitespace but keeps paragraphs', () => {
    expect(tidy('a\t\tb  \n\n\n\nc\u00a0d')).toBe('a b\n\nc d');
  });
});

describe('chunking', () => {
  const sentence = (i: number) =>
    `Sentence number ${i} talks about the roadmap and pricing in detail.`;

  it('never crosses a page, and stays near the target size', () => {
    const long = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkPages(
      [
        { page: 1, text: long },
        { page: 2, text: 'A short second page.' },
      ],
      { paged: true },
    );
    expect(chunks.at(-1)).toMatchObject({ page: 2, text: 'A short second page.' });
    for (const c of chunks.filter((c) => c.page === 1)) {
      expect(c.text.length).toBeLessThanOrEqual(TARGET_CHARS + 200);
    }
    // Consecutive passages share their boundary sentence, so nothing is lost there.
    const [a, b] = chunks;
    const last = sentences(a!.text).at(-1)!;
    expect(b!.text).toContain(last);
    expect(b!.text.indexOf(last)).toBeLessThan(200);
  });

  it('leaves page numbers off formats without pages', () => {
    expect(chunkPages([{ page: 1, text: 'Hello.' }], { paged: false })[0]!.page).toBeNull();
  });

  it('cuts run-on text without full stops', () => {
    const parts = sentences('word '.repeat(1_000));
    expect(parts.length).toBeGreaterThan(1);
    expect(Math.max(...parts.map((p) => p.length))).toBeLessThanOrEqual(1_800);
  });

  it('windows a transcript by size and time, keeping where each window starts', () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({
      startMs: i * 5_000,
      endMs: i * 5_000 + 4_500,
      text: `Line ${i} of the standup.`,
      speaker: i % 2 ? 'Tunde' : null,
    }));
    const chunks = chunkTranscript(lines);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks[0]).toMatchObject({ startMs: 0, page: null });
    for (const c of chunks) {
      expect(c.endMs! - c.startMs!).toBeLessThanOrEqual(95_000);
      expect(c.endMs).toBeGreaterThan(c.startMs!);
    }
    expect(chunks.some((c) => c.text.includes('Tunde: Line 1 of'))).toBe(true);
    expect(chunks.at(-1)!.endMs).toBe(119 * 5_000 + 4_500);
  });
});

describe('meeting notes', () => {
  const lines = [
    { startMs: 0, endMs: 4_000, text: 'Welcome everyone to the weekly product sync.' },
    { startMs: 65_000, endMs: 70_000, text: 'We decided to ship the pricing page on Friday.' },
    {
      startMs: 130_000,
      endMs: 136_000,
      text: "I'll send the deck to the board by tomorrow.",
      speaker: 'Tunde',
    },
    { startMs: 200_000, endMs: 205_000, text: 'Should BYOK customers pay less?' },
  ];

  it('formats clock times like the player', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
  });

  it('reads a model’s JSON even when wrapped in prose, and clamps times', () => {
    const raw = `Here you go:\n\`\`\`json\n${JSON.stringify({
      summary: ' A sync. ',
      decisions: ['Ship Friday', ''],
      actionItems: [{ text: 'Send deck', owner: 'Tunde', due: 'tomorrow', atMs: 999_999_999 }],
      openQuestions: [],
      chapters: [
        { title: 'Pricing', startMs: 65_000 },
        { title: 'Intro', startMs: -5 },
      ],
    })}\n\`\`\``;
    const parsed = parseInsights(raw, 210_000)!;
    expect(parsed.summary).toBe('A sync.');
    expect(parsed.decisions).toEqual(['Ship Friday']);
    expect(parsed.actionItems[0]).toMatchObject({ owner: 'Tunde', atMs: 210_000 });
    expect(parsed.chapters.map((c) => c.title)).toEqual(['Intro', 'Pricing']);
    expect(parseInsights('no json here', 1)).toBeNull();
    expect(parseInsights('{"summary": 1}', 1)).toBeNull();
  });

  it('writes labelled basic notes without a model', () => {
    const notes = basicInsights(lines, 210_000);
    expect(notes.summary).toContain('Welcome everyone');
    expect(notes.decisions).toEqual(['We decided to ship the pricing page on Friday.']);
    expect(notes.actionItems[0]).toMatchObject({ owner: 'Tunde', due: 'tomorrow', atMs: 130_000 });
    expect(notes.openQuestions).toEqual(['Should BYOK customers pay less?']);
    expect(notes.chapters[0]!.startMs).toBe(0);
  });

  it('asks a chat model, retries once on unreadable output', async () => {
    const answers = [
      'sorry, I can’t',
      JSON.stringify({
        summary: 'Sync',
        decisions: [],
        actionItems: [],
        openQuestions: [],
        chapters: [{ title: 'All', startMs: 0 }],
      }),
    ];
    const prompts: string[] = [];
    const chat: ChatProvider = {
      id: 'stub',
      label: 'stub',
      capability: 'chat',
      dataLocation: 'IN_CLUSTER',
      async *stream(req): AsyncIterable<ChatChunk> {
        prompts.push(req.messages.at(-1)!.content);
        yield { type: 'text', text: answers.shift()! };
        yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const notes = await modelInsights(chat, 'm', lines, 210_000);
    expect(notes?.summary).toBe('Sync');
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('[1:05] We decided');
    expect(prompts[0]).toContain('[2:10] Tunde: I’ll'.replace('’', "'"));
  });
});
