/**
 * Ask during a live call: the transcript so far isn't indexed yet (the pipeline does that when
 * the call ends), so it's offered to Ask as passages built here. The call is cut into stretches
 * of about 45 seconds; the stretches sharing the most words with the question go in, and the
 * latest stretch always does, because a question mid-call is often about what was just said.
 */

export interface LiveLine {
  seq: number;
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

export interface LiveStretch {
  /** `seq.idx` of its first line: unique within the call. */
  key: string;
  startMs: number;
  endMs: number;
  text: string;
}

const STRETCH_MS = 45_000;
const STOP_WORDS = new Set(
  'a an and are as at be but by did do does for from had has have he her his how i in is it its me my no not of on or our she so that the their them then there these they this to us was we were what when where which who why will with you your'.split(
    ' ',
  ),
);

export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
  );
}

/** Consecutive lines grouped into stretches of about 45 seconds. */
export function stretches(lines: readonly LiveLine[]): LiveStretch[] {
  const out: LiveStretch[] = [];
  let current: LiveLine[] = [];
  const flush = () => {
    if (!current.length) return;
    out.push({
      key: `${current[0]!.seq}.${current[0]!.idx}`,
      startMs: current[0]!.startMs,
      endMs: current.at(-1)!.endMs,
      text: current.map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join(' '),
    });
    current = [];
  };
  for (const line of lines) {
    if (current.length && line.startMs - current[0]!.startMs >= STRETCH_MS) flush();
    current.push(line);
  }
  flush();
  return out;
}

/**
 * The stretches to offer for a question, most relevant first, the latest always among them.
 * At most `max`; a stretch with no word in common only gets in as the latest.
 */
export function relevantStretches(
  lines: readonly LiveLine[],
  question: string,
  max = 3,
): LiveStretch[] {
  const all = stretches(lines);
  if (!all.length) return [];
  const asked = words(question);
  const latest = all.at(-1)!;
  const scored = all
    .slice(0, -1)
    .map((s) => {
      const said = words(s.text);
      let score = 0;
      for (const w of asked) if (said.has(w)) score += 1;
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.s.startMs - a.s.startMs)
    .slice(0, Math.max(0, max - 1))
    .map((x) => x.s);
  return [...scored, latest];
}
