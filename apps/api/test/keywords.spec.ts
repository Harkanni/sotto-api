import { describe, expect, it } from 'vitest';
import { keywordQuery, keywordsOf, lightStem } from '../src/ask/keywords.js';

describe('keyword queries', () => {
  it('keeps the words that carry meaning, once each', () => {
    expect(keywordsOf('What did we decide about pricing?')).toEqual(['decide', 'pricing']);
    expect(keywordsOf('Who owns the launch? The LAUNCH plan!')).toEqual(['owns', 'launch', 'plan']);
    expect(keywordsOf('the team’s Q4 roadmap')).toEqual(['team', 'q4', 'roadmap']);
  });

  it('stems lightly so related forms meet', () => {
    expect(lightStem('pricing')).toBe('pric');
    expect(lightStem('price')).toBe('pric');
    expect(lightStem('decided')).toBe('decid');
    expect(lightStem('recordings')).toBe('record');
    expect(lightStem('replies')).toBe('repl');
    // Short words stay whole.
    expect(lightStem('uses')).toBe('uses');
    expect(lightStem('q4')).toBe('q4');
  });

  it('ORs prefix terms, so passages with more of them rank first', () => {
    expect(keywordQuery('What did we decide about pricing?')).toBe('decid:* | pric:*');
  });

  it('returns null when nothing is searchable', () => {
    expect(keywordQuery('what is the?')).toBeNull();
    expect(keywordQuery('   ')).toBeNull();
  });

  it('never lets tsquery syntax through', () => {
    const query = keywordQuery("pricing') | !secret & <-> :* (x)");
    expect(query).toBe('pric:* | secret:*');
    expect(query).toMatch(/^[\p{L}\p{N}]+:\*( \| [\p{L}\p{N}]+:\*)*$/u);
  });
});
