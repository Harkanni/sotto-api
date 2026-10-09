import { describe, expect, it } from 'vitest';
import { similarityFloor } from '../src/ask/retrieval.service.js';

describe('similarityFloor', () => {
  it('uses the floor measured for the model, whatever its tag', () => {
    expect(similarityFloor('nomic-embed-text')).toBe(0.65);
    expect(similarityFloor('nomic-embed-text:latest')).toBe(0.65);
  });

  it('falls back to the default for unmeasured models', () => {
    expect(similarityFloor('bge-m3')).toBe(0.5);
  });

  it('lets ASK_MIN_SIMILARITY override it', () => {
    expect(similarityFloor('nomic-embed-text', 0.7)).toBe(0.7);
    expect(similarityFloor('bge-m3', 0)).toBe(0);
  });
});
