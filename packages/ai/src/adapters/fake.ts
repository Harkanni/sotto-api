/**
 * MOCK providers. They make no network calls and return deterministic output, for tests, CI and
 * running the stack before real models are wired in. Every one sets `isMock: true` so the UI can
 * label anything they produce.
 */
import type { ChatChunk, ChatProvider, ChatRequest, EmbeddingProvider } from '../types.js';

export class FakeChatProvider implements ChatProvider {
  readonly id = 'fake';
  readonly label = 'Mock chat (no model)';
  readonly capability = 'chat' as const;
  readonly dataLocation = 'IN_CLUSTER' as const;
  readonly isMock = true;

  async *stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    const last = request.messages.at(-1)?.content ?? '';
    const words = `[mock] You asked: ${last}`.split(' ');
    for (const [i, word] of words.entries()) {
      yield { type: 'text', text: i === 0 ? word : ` ${word}` };
    }
    yield { type: 'done', usage: { inputTokens: last.length, outputTokens: words.length } };
  }
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly label = 'Mock embeddings (hash-based)';
  readonly capability = 'embedding' as const;
  readonly dataLocation = 'IN_CLUSTER' as const;
  readonly isMock = true;

  constructor(
    readonly dimensions = 8,
    readonly model = 'fake-hash',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (let i = 0; i < text.length; i++) {
        const slot = i % this.dimensions;
        vector[slot] = (vector[slot] ?? 0) + text.charCodeAt(i);
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((v) => v / norm);
    });
  }
}
