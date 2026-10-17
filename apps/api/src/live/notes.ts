import type { ChatProvider } from '@sotto/ai';
import { z } from 'zod';

/**
 * Notes written while a call is still going: a short summary, the main points so far and the
 * action items heard. Smaller than the saved meeting's insights (the pipeline writes those from
 * the full-quality transcript when the call ends), and rewritten every few minutes.
 */
export interface LiveNotes {
  summary: string;
  points: string[];
  actions: { text: string; owner: string | null }[];
}

/** The latest part of the call that fits one request; the summary carries what came before. */
const MAX_TRANSCRIPT_CHARS = 20_000;

export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

/** "[12:04] We ship on Friday." — newest lines kept when the call outgrows one request. */
export function liveTranscriptText(
  lines: readonly { startMs: number; text: string; speaker: string | null }[],
  maxChars = MAX_TRANSCRIPT_CHARS,
): string {
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const text = `[${clock(line.startMs)}] ${line.speaker ? `${line.speaker}: ` : ''}${line.text}`;
    if (size + text.length + 1 > maxChars && out.length) break;
    out.push(text);
    size += text.length + 1;
  }
  return out.reverse().join('\n');
}

const SYSTEM = `You keep running notes during a meeting that is still happening. Answer with one JSON object and nothing else:
{"summary": string, "points": string[], "actions": [{"text": string, "owner": string|null}]}
Rules:
- Use only what the transcript says. Never invent names, dates or decisions.
- summary: 1-3 plain sentences about the meeting so far. If earlier notes are given, keep what still matters from them.
- points: up to 6 short main points or decisions so far, in order.
- actions: things someone said they or another person will do; owner only when a name is said.
- The transcript is automatic and may have mistakes; don't quote obvious errors.
- Write in the transcript's language.`;

const ModelAnswer = z.object({
  summary: z.string(),
  points: z.array(z.string()).default([]),
  actions: z.array(z.object({ text: z.string(), owner: z.string().nullish() })).default([]),
});

/** Reads a model's answer leniently (prose or fences around the JSON); null when it can't. */
export function parseLiveNotes(raw: string): LiveNotes | null {
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
  if (!parsed.success || !parsed.data.summary.trim()) return null;
  return {
    summary: parsed.data.summary.trim(),
    points: parsed.data.points
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, 6),
    actions: parsed.data.actions
      .filter((a) => a.text.trim())
      .slice(0, 12)
      .map((a) => ({ text: a.text.trim(), owner: a.owner?.trim() || null })),
  };
}

/** One request for notes; two tries at a readable answer. Returns the notes and tokens used. */
export async function writeLiveNotes(
  chat: ChatProvider,
  model: string,
  transcript: string,
  previous: LiveNotes | null,
  signal?: AbortSignal,
): Promise<{ notes: LiveNotes | null; inputTokens: number; outputTokens: number }> {
  const user =
    (previous ? `Earlier notes:\n${JSON.stringify(previous)}\n\n` : '') +
    `Transcript so far:\n${transcript}`;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = '';
    for await (const chunk of chat.stream({
      model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      maxOutputTokens: 800,
      json: true,
      ...(signal ? { signal } : {}),
    })) {
      if (chunk.type === 'text') text += chunk.text;
      else {
        inputTokens += chunk.usage.inputTokens;
        outputTokens += chunk.usage.outputTokens;
      }
    }
    const notes = parseLiveNotes(text);
    if (notes) return { notes, inputTokens, outputTokens };
  }
  return { notes: null, inputTokens, outputTokens };
}
