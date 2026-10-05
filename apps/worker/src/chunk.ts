/**
 * Splits text into the passages that get embedded and cited. Two shapes:
 *
 * - Documents: passages never cross a page, so a citation names one page exactly.
 * - Recordings: passages are windows of transcript lines, so a citation plays from a moment.
 *
 * Sizes are in characters (≈ 4 per token for English): ~1,200 characters (~300 tokens) is long
 * enough to carry a whole thought and short enough that a citation points somewhere specific.
 * Neighbouring passages overlap by a sentence or a line, so an idea split at a boundary is still
 * found whole in one of them.
 */

export interface ChunkDraft {
  text: string;
  tokenCount: number;
  page: number | null;
  startMs: number | null;
  endMs: number | null;
}

export const TARGET_CHARS = 1_200;
const MAX_CHARS = 1_800;
const OVERLAP_CHARS = 200;
/** Recordings: also cut a window after this long, so a citation lands near the moment. */
const MAX_WINDOW_MS = 90_000;

/** A rough token count (no tokenizer per model); used for budgeting, never for billing. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Sentences, keeping their punctuation; long sentence-less runs are cut at spaces. */
export function sentences(paragraph: string): string[] {
  const parts = paragraph.match(/[^.!?…]+(?:[.!?…]+["'’”)\]]*|$)\s*/g) ?? [paragraph];
  const out: string[] = [];
  for (const part of parts.map((p) => p.trim()).filter(Boolean)) {
    if (part.length <= MAX_CHARS) {
      out.push(part);
      continue;
    }
    // A table or a list without full stops: cut at the last space before the limit.
    let rest = part;
    while (rest.length > MAX_CHARS) {
      const cut =
        rest.lastIndexOf(' ', TARGET_CHARS) > 0
          ? rest.lastIndexOf(' ', TARGET_CHARS)
          : TARGET_CHARS;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** The tail of a passage to repeat at the start of the next (whole sentences, ≤ 200 chars). */
function overlapOf(units: string[]): string[] {
  const tail: string[] = [];
  let size = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    size += units[i]!.length + 1;
    if (size > OVERLAP_CHARS) break;
    tail.unshift(units[i]!);
  }
  return tail;
}

export function chunkPages(
  pages: readonly { page: number; text: string }[],
  options: { paged: boolean },
): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  for (const { page, text } of pages) {
    const units = text
      .split(/\n{2,}/)
      .flatMap((paragraph) => sentences(paragraph.replace(/\n/g, ' ')));
    let current: string[] = [];
    let size = 0;
    let fresh = 0; // sentences in `current` that aren't overlap from the previous passage
    const flush = () => {
      if (!fresh) return;
      const body = current.join(' ').trim();
      out.push({
        text: body,
        tokenCount: estimateTokens(body),
        page: options.paged ? page : null,
        startMs: null,
        endMs: null,
      });
      current = overlapOf(current);
      size = current.join(' ').length;
      fresh = 0;
    };
    for (const unit of units) {
      if (size + unit.length > TARGET_CHARS && fresh > 0) flush();
      current.push(unit);
      size += unit.length + 1;
      fresh += 1;
    }
    flush();
  }
  return out;
}

export interface Line {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
}

export function chunkTranscript(lines: readonly Line[]): ChunkDraft[] {
  const out: ChunkDraft[] = [];
  let current: Line[] = [];
  let size = 0;
  let fresh = 0;
  const flush = () => {
    if (!fresh) return;
    const body = current
      .map((l) => (l.speaker ? `${l.speaker}: ${l.text}` : l.text))
      .join(' ')
      .trim();
    out.push({
      text: body,
      tokenCount: estimateTokens(body),
      page: null,
      startMs: current[0]!.startMs,
      endMs: current.at(-1)!.endMs,
    });
    // One line of overlap keeps a sentence split across windows findable.
    current = current.slice(-1);
    size = current[0]!.text.length;
    fresh = 0;
  };
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const window = current.length ? line.endMs - current[0]!.startMs : 0;
    if (fresh > 0 && (size + text.length > TARGET_CHARS || window > MAX_WINDOW_MS)) flush();
    current.push({ ...line, text });
    size += text.length + 1;
    fresh += 1;
  }
  flush();
  return out;
}
