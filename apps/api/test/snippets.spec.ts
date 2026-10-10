import { describe, expect, it } from 'vitest';
import { titleOfNote } from '../src/ask/notes.controller.js';
import { highlightsIn, snippetOf } from '../src/ask/snippets.js';

const marked = (s: { text: string; highlights: [number, number][] }) =>
  s.highlights.map(([a, b]) => s.text.slice(a, b));

describe('search snippets', () => {
  it('marks the words the keyword search matched, by their stems', () => {
    const text = 'We decided to keep the free tier and price Business per seat.';
    expect(
      highlightsIn(text, 'what did we decide about pricing').map(([a, b]) => text.slice(a, b)),
    ).toEqual(['decided', 'price']);
  });

  it('keeps short passages whole', () => {
    const s = snippetOf('Offline recording is a launch requirement.', 'offline');
    expect(s.text).toBe('Offline recording is a launch requirement.');
    expect(marked(s)).toEqual(['Offline']);
  });

  it('windows long passages around the first match, at word boundaries', () => {
    const filler = 'Lorem ipsum dolor sit amet consectetur. '.repeat(12);
    const text = `${filler}The runway is 21 months at the current burn. ${filler}`;
    const s = snippetOf(text, 'runway', 120);
    expect(s.text.startsWith('…')).toBe(true);
    expect(s.text.endsWith('…')).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(122);
    expect(marked(s)).toEqual(['runway']);
    expect(s.text).not.toMatch(/^…\S*\s{2}/);
  });

  it('drops Markdown markers', () => {
    const s = snippetOf(
      '## Risks\n\n1. Unreliable **connectivity** on field visits.',
      'connectivity',
    );
    expect(s.text).toBe('Risks Unreliable connectivity on field visits.');
    expect(marked(s)).toEqual(['connectivity']);
    // As chunks store it: line breaks flattened.
    expect(snippetOf('health. ## Risks 1. Unreliable', 'risks').text).toBe(
      'health. Risks 1. Unreliable',
    );
  });

  it('starts at the beginning when nothing matches (a match by meaning)', () => {
    const s = snippetOf('a '.repeat(200), 'cash', 50);
    expect(s.text.startsWith('a a')).toBe(true);
    expect(s.highlights).toEqual([]);
  });
});

describe('note titles', () => {
  it('uses the first line with words, without Markdown', () => {
    expect(titleOfNote('# Launch risks\nBody')).toBe('Launch risks');
    expect(titleOfNote('\n\n- **Call** Bluebird')).toBe('Call Bluebird');
    expect(titleOfNote('   \n')).toBe('Untitled note');
    expect(titleOfNote('x'.repeat(120))).toHaveLength(80);
  });
});
