import { describe, expect, it } from 'vitest';
import {
  canSend,
  FakeChatProvider,
  FakeEmbeddingProvider,
  parseModelRef,
  partitionSources,
  ProviderNotFoundError,
  ProviderRegistry,
} from '../src/index.js';

describe('privacy policy', () => {
  const strict = { confidentialAllowsThirdParty: false };
  const relaxed = { confidentialAllowsThirdParty: true };

  it('never sends Restricted content to a third party', () => {
    expect(canSend('RESTRICTED', 'THIRD_PARTY', relaxed)).toBe(false);
    expect(canSend('RESTRICTED', 'IN_CLUSTER', strict)).toBe(true);
  });

  it('sends Confidential content out only when the workspace allows it', () => {
    expect(canSend('CONFIDENTIAL', 'THIRD_PARTY', strict)).toBe(false);
    expect(canSend('CONFIDENTIAL', 'THIRD_PARTY', relaxed)).toBe(true);
  });

  it('counts hidden sources for the UI notice', () => {
    const sources = [
      { id: 1, sensitivity: 'INTERNAL' as const },
      { id: 2, sensitivity: 'RESTRICTED' as const },
      { id: 3, sensitivity: 'RESTRICTED' as const },
    ];
    const { allowed, hidden } = partitionSources(sources, 'THIRD_PARTY', relaxed);
    expect(allowed.map((s) => s.id)).toEqual([1]);
    expect(hidden).toBe(2);
  });
});

describe('provider registry', () => {
  it('resolves providers by capability and id', () => {
    const registry = new ProviderRegistry()
      .register(new FakeChatProvider())
      .register(new FakeEmbeddingProvider());
    expect(registry.get('chat', 'fake').label).toContain('Mock');
    expect(registry.get('embedding', 'fake').dimensions).toBe(8);
  });

  it('explains what is available when a provider is missing', () => {
    const registry = new ProviderRegistry().register(new FakeChatProvider());
    expect(() => registry.get('chat', 'vllm')).toThrow(ProviderNotFoundError);
    expect(() => registry.get('chat', 'vllm')).toThrow(/Available: fake/);
  });

  it('rejects duplicate registrations', () => {
    const registry = new ProviderRegistry().register(new FakeChatProvider());
    expect(() => registry.register(new FakeChatProvider())).toThrow(/already registered/);
  });

  it('parses provider:model references', () => {
    expect(parseModelRef('ollama:nomic-embed-text')).toEqual({
      provider: 'ollama',
      model: 'nomic-embed-text',
    });
    expect(parseModelRef('ollama:llama3.2:3b').model).toBe('llama3.2:3b');
    expect(() => parseModelRef('nomic')).toThrow();
  });
});

describe('mock adapters', () => {
  it('embeds deterministically with unit-length vectors', async () => {
    const provider = new FakeEmbeddingProvider(4);
    const [a, b] = await provider.embed(['hello', 'hello']);
    expect(a).toEqual(b);
    expect(Math.hypot(...(a ?? []))).toBeCloseTo(1);
  });

  it('streams a labelled mock answer', async () => {
    let text = '';
    for await (const chunk of new FakeChatProvider().stream({
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      if (chunk.type === 'text') text += chunk.text;
    }
    expect(text).toBe('[mock] You asked: hi');
  });
});
