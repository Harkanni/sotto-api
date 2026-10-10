/**
 * Turns a question into a Postgres full-text query for the keyword half of hybrid search.
 *
 * Chunks are indexed with the `simple` configuration (no stemming, no stop words, any language),
 * so the question is prepared here instead:
 *
 * - Words are OR-ed, not AND-ed. A question ("What did we decide about pricing?") rarely has
 *   every word in one passage; ranking (ts_rank_cd) puts passages with more of them first.
 * - Common English words that carry no meaning are dropped, so they don't match everything.
 * - Each word is a prefix of a light stem: "pricing" → `pric:*` finds "price" and "prices",
 *   "decided" → `decid:*` finds "decide" and "decision".
 *
 * The result only ever contains letters, digits and the operators written here, so it's safe to
 * pass to `to_tsquery` (as a bound parameter, never spliced into SQL).
 */

const STOP_WORDS = new Set(
  (
    'a about above after again all am an and any are as at be been before being below between ' +
    'both but by can could did do does doing down during each few for from further had has have ' +
    'having he her here hers him his how i if in into is it its just me more most my no nor not ' +
    'now of off on once only or other our ours out over own same she should so some such than ' +
    'that the their theirs them then there these they this those through to too under until up ' +
    'very was we were what when where which while who whom why will with would you your yours ' +
    'tell show give find let us please know anything something thing things say said says get got'
  ).split(' '),
);

/** The longest a stem may be cut back to; shorter words keep their full form. */
const MIN_STEM = 4;

/** Strips a common English suffix, keeping at least MIN_STEM characters. */
export function lightStem(word: string): string {
  for (const suffix of ['ations', 'ation', 'ings', 'ing', 'ied', 'ies', 'ed', 'es', 's']) {
    // "replies" → "repl", which still prefixes "reply".
    if (word.endsWith(suffix) && word.length - suffix.length >= MIN_STEM) {
      return word.slice(0, -suffix.length);
    }
  }
  // "price" and "pricing" should meet at "pric".
  if (word.endsWith('e') && word.length - 1 >= MIN_STEM) return word.slice(0, -1);
  return word;
}

/** The meaningful words of a question, lowercased, in order, without duplicates. */
export function keywordsOf(question: string): string[] {
  const words = question
    .toLowerCase()
    .normalize('NFKC')
    // A possessive is the word itself ("team's" → "team"); other apostrophes join ("don't").
    .replace(/(\p{L})['’]s(?!\p{L})/gu, '$1')
    .replace(/(\p{L})['’](\p{L})/gu, '$1$2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, 24);
}

/** A `to_tsquery('simple', …)` string, or null when nothing in the question is searchable. */
export function keywordQuery(question: string): string | null {
  const terms = [...new Set(keywordsOf(question).map(lightStem))];
  if (!terms.length) return null;
  return terms.map((t) => `${t}:*`).join(' | ');
}
