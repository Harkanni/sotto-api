import type { ChatProvider } from '@sotto/ai';
import type { MeetingInsightsBody } from '@sotto/contracts';
import { z } from 'zod';
import type { Line } from './chunk.js';

/**
 * Meeting notes (BRIEF §4): a summary, decisions, action items with owner and due date when
 * mentioned, open questions, and chapters with timestamps.
 *
 * With a private chat model configured, it writes them. Without one, `basicInsights` makes a
 * plain, rule-based version that's clearly labelled (`isMock`), so the screen is never empty and
 * never pretends an AI read the meeting.
 */

/** Characters of transcript sent in one request. Longer meetings are noted in parts, then merged. */
const PART_CHARS = 24_000;

export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** "[12:04] Tunde: We ship on Friday." — timestamps let the model place chapters and items. */
export function transcriptText(lines: readonly Line[]): string {
  return lines
    .map((l) => `[${clock(l.startMs)}] ${l.speaker ? `${l.speaker}: ` : ''}${l.text.trim()}`)
    .join('\n');
}

const SYSTEM = `You write meeting notes from a transcript. Answer with one JSON object and nothing else:
{"summary": string, "decisions": string[], "actionItems": [{"text": string, "owner": string|null, "due": string|null, "atMs": number|null}], "openQuestions": string[], "chapters": [{"title": string, "startMs": number}]}
Rules:
- Use only what the transcript says. Never invent names, dates or decisions.
- summary: 2-4 plain sentences.
- owner and due only when someone is named or a date is said; otherwise null.
- atMs and startMs are milliseconds from the start, taken from the [m:ss] stamps.
- chapters: 3-8 short titles in order, the first at 0.
- Write in the transcript's language.`;

/**
 * What a model may send back: looser than the stored shape (missing lists, negative or
 * fractional times), so a near-miss is repaired below instead of thrown away.
 */
const ModelAnswer = z.object({
  summary: z.string(),
  decisions: z.array(z.string()).default([]),
  actionItems: z
    .array(
      z.object({
        text: z.string(),
        owner: z.string().nullish(),
        due: z.string().nullish(),
        atMs: z.number().nullish(),
      }),
    )
    .default([]),
  openQuestions: z.array(z.string()).default([]),
  chapters: z.array(z.object({ title: z.string(), startMs: z.number() })).default([]),
});

/** Pulls the first JSON object out of a model's answer (some wrap it in prose or fences). */
export function parseInsights(raw: string, durationMs: number): MeetingInsightsBody | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const parsed = ModelAnswer.safeParse(value);
  if (!parsed.success) return null;
  const clamp = (ms: number) => Math.min(Math.max(0, Math.round(ms)), durationMs);
  const chapters = parsed.data.chapters
    .map((c) => ({ title: c.title.trim(), startMs: clamp(c.startMs) }))
    .filter((c) => c.title)
    .sort((a, b) => a.startMs - b.startMs);
  return {
    summary: parsed.data.summary.trim(),
    decisions: parsed.data.decisions.map((d) => d.trim()).filter(Boolean),
    actionItems: parsed.data.actionItems
      .filter((a) => a.text.trim())
      .map((a) => ({
        text: a.text.trim(),
        owner: a.owner?.trim() || null,
        due: a.due?.trim() || null,
        atMs: a.atMs == null ? null : clamp(a.atMs),
      })),
    openQuestions: parsed.data.openQuestions.map((q) => q.trim()).filter(Boolean),
    chapters,
  };
}

async function ask(
  chat: ChatProvider,
  model: string,
  user: string,
  signal?: AbortSignal,
): Promise<string> {
  let text = '';
  for await (const chunk of chat.stream({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    maxOutputTokens: 1_500,
    json: true,
    ...(signal ? { signal } : {}),
  })) {
    if (chunk.type === 'text') text += chunk.text;
  }
  return text;
}

/** Splits a long transcript into parts of whole lines. */
function parts(lines: readonly Line[]): Line[][] {
  const out: Line[][] = [[]];
  let size = 0;
  for (const line of lines) {
    if (size + line.text.length > PART_CHARS && out.at(-1)!.length) {
      out.push([]);
      size = 0;
    }
    out.at(-1)!.push(line);
    size += line.text.length + 12;
  }
  return out;
}

/**
 * Notes from a chat model. Long meetings are noted part by part, then the parts' notes are
 * merged in one more request. Returns null if the model's answers can't be read twice over.
 */
export async function modelInsights(
  chat: ChatProvider,
  model: string,
  lines: readonly Line[],
  durationMs: number,
  signal?: AbortSignal,
): Promise<MeetingInsightsBody | null> {
  const attempt = async (prompt: string) => {
    for (let i = 0; i < 2; i++) {
      const parsed = parseInsights(await ask(chat, model, prompt, signal), durationMs);
      if (parsed) return parsed;
    }
    return null;
  };
  const split = parts(lines);
  if (split.length === 1) return attempt(`Transcript:\n${transcriptText(lines)}`);

  const notes: MeetingInsightsBody[] = [];
  for (const part of split) {
    const n = await attempt(`Transcript (one part of a longer meeting):\n${transcriptText(part)}`);
    if (n) notes.push(n);
  }
  if (!notes.length) return null;
  const merged = await attempt(
    `These are notes from consecutive parts of one meeting. Merge them into notes for the whole ` +
      `meeting, keeping timestamps:\n${JSON.stringify(notes)}`,
  );
  return merged;
}

// ── Basic notes, without a model ────────────────────────────────────────────────────────────

const ACTION =
  /\b(I'?ll|I will|we'?ll|we will|(?:can|could) you|let'?s|action item|by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week|end of (?:day|week)))\b/i;
const DECISION =
  /\b(we (?:decided|agreed|chose|will go with)|decision is|let'?s go with|agreed)\b/i;
const QUESTION = /\?\s*$/;
const DUE =
  /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|end of (?:the )?(?:day|week|month))\b/i;

/**
 * Rule-based notes: the opening lines as a summary, lines that sound like decisions, actions or
 * questions, and a chapter every few minutes titled by its first words. Labelled as basic notes
 * (`isMock`) wherever they're shown.
 */
export function basicInsights(lines: readonly Line[], durationMs: number): MeetingInsightsBody {
  const text = (l: Line) => l.text.trim();
  const opening = lines
    .map(text)
    .filter((t) => t.split(' ').length >= 5)
    .slice(0, 3)
    .join(' ');
  const pick = (re: RegExp, max: number) => lines.filter((l) => re.test(text(l))).slice(0, max);

  const every = Math.max(60_000, Math.ceil(durationMs / 6 / 60_000) * 60_000);
  const chapters: { title: string; startMs: number }[] = [];
  for (let at = 0; at < Math.max(durationMs, 1); at += every) {
    const first = lines.find((l) => l.startMs >= at && text(l).split(' ').length >= 3);
    if (!first || first.startMs >= at + every) continue;
    const words = text(first)
      .replace(/[.!?,;:]+$/, '')
      .split(/\s+/)
      .slice(0, 6)
      .join(' ');
    chapters.push({ title: words, startMs: first.startMs });
  }

  return {
    summary: opening
      ? `Opening of the meeting: ${opening}`
      : 'No speech was found in this recording.',
    decisions: pick(DECISION, 5).map(text),
    actionItems: pick(ACTION, 8).map((l) => ({
      text: text(l),
      owner: l.speaker ?? null,
      due: DUE.exec(text(l))?.[0] ?? null,
      atMs: l.startMs,
    })),
    openQuestions: pick(QUESTION, 5).map(text),
    chapters,
  };
}
