import { keywordsOf, lightStem } from './keywords.js';

/** A run of text with the parts that matched the search marked as [start, end) offsets. */
export interface Snippet {
  text: string;
  highlights: [number, number][];
}

/**
 * Where the question's words appear in a passage: each word of the text that starts with one of
 * the question's stems, the same rule the keyword search used to find it. Offsets, not markup,
 * so the web draws highlights without parsing HTML.
 */
export function highlightsIn(text: string, question: string): [number, number][] {
  const stems = keywordsOf(question).map(lightStem);
  if (!stems.length) return [];
  const ranges: [number, number][] = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0].toLowerCase();
    if (stems.some((stem) => word.startsWith(stem))) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

/**
 * A window of about `max` characters around the first match, cut at word boundaries, with "…"
 * where text was left out, and the highlights moved to fit. Without a match, the start.
 */
export function snippetOf(text: string, question: string, max = 220): Snippet {
  // Snippets are plain text: Markdown headings, bullets and bold markers go.
  const clean = text
    // Chunks have their line breaks flattened, so markers are found anywhere, not at line starts.
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const all = highlightsIn(clean, question);
  if (clean.length <= max) return { text: clean, highlights: all };

  const first = all[0]?.[0] ?? 0;
  // Some context before the match, most of the window after it.
  let start = Math.max(0, first - Math.floor(max / 4));
  let end = Math.min(clean.length, start + max);
  start = Math.max(0, end - max);
  if (start > 0) {
    const space = clean.indexOf(' ', start);
    if (space !== -1 && space < first) start = space + 1;
  }
  if (end < clean.length) {
    const space = clean.lastIndexOf(' ', end);
    if (space > start) end = space;
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < clean.length ? '…' : '';
  const shift = prefix.length - start;
  return {
    text: `${prefix}${clean.slice(start, end)}${suffix}`,
    highlights: all
      .filter(([s, e]) => s >= start && e <= end)
      .map(([s, e]) => [s + shift, e + shift] as [number, number]),
  };
}
