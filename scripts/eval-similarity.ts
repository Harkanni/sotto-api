/**
 * How close a real embedding model puts each eval question to its answer, and each
 * unanswerable question to anything at all: the numbers the relevance floor
 * (MIN_SIMILARITY, apps/api/src/ask/retrieval.service.ts) is set from. Run after
 * scripts/eval.ts has indexed the sample content (CI's `evals` job runs both).
 *
 * For every question it embeds the question the way the api does (nomic's "search_query: "
 * prefix), then asks Postgres for the best cosine similarity among the files that answer it and
 * among all files. Prints a table and, on GitHub Actions, one notice with the summary.
 *
 * Needs Node 24, Docker Compose (it runs psql inside compose.deps.yaml's postgres) and:
 *   OLLAMA_URL   e.g. http://localhost:11434     EMBED_MODEL  default nomic-embed-text
 */
import { spawnSync } from 'node:child_process';
import { QUESTIONS, UNANSWERABLE } from '../evals/kestrel.ts';

const OLLAMA = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.EMBED_MODEL ?? 'nomic-embed-text';

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, input: `search_query: ${text}` }),
  });
  if (!res.ok) throw new Error(`embed: ${res.status}`);
  const body = (await res.json()) as { embeddings: number[][] };
  return body.embeddings[0]!;
}

/** Best similarity per file title for one question vector, as `title<TAB>similarity` lines. */
function bestPerFile(vector: number[]): Map<string, number> {
  const sql = `SELECT f.title, max(1 - (ce.embedding::vector <=> '[${vector.join(',')}]'::vector))
    FROM chunk_embeddings ce JOIN chunks c ON c.id = ce.chunk_id JOIN files f ON f.id = c.file_id
    WHERE ce.model LIKE '%:${MODEL}' GROUP BY f.title;`;
  const out = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      'compose.deps.yaml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'sotto',
      '-d',
      'sotto',
      '-At',
      '-F',
      '\t',
    ],
    { input: sql, encoding: 'utf8' },
  );
  if (out.status !== 0) throw new Error(`psql: ${out.stderr}`);
  const best = new Map<string, number>();
  for (const line of out.stdout.trim().split('\n').filter(Boolean)) {
    const [title, sim] = line.split('\t');
    best.set(title!, Number(sim));
  }
  return best;
}

const fmt = (n: number) => n.toFixed(3);

async function main(): Promise<void> {
  const answerable: number[] = [];
  const unanswerable: number[] = [];
  console.log('| Question | Best in its answer | Best elsewhere |\n| --- | --- | --- |');
  for (const q of QUESTIONS) {
    const best = bestPerFile(await embed(q.question));
    const own = Math.max(...q.expect.map((t) => best.get(t) ?? -1));
    const other = Math.max(...[...best].filter(([t]) => !q.expect.includes(t)).map(([, s]) => s));
    answerable.push(own);
    console.log(`| ${q.id} | ${fmt(own)} | ${fmt(other)} |`);
  }
  for (const question of UNANSWERABLE) {
    const best = Math.max(...bestPerFile(await embed(question)).values());
    unanswerable.push(best);
    console.log(`| (unanswerable) ${question} | – | ${fmt(best)} |`);
  }
  const sorted = (xs: number[]) =>
    [...xs]
      .sort((a, b) => a - b)
      .map(fmt)
      .join(' ');
  const summary = `answers: ${sorted(answerable)} · unanswerable best: ${sorted(unanswerable)}`;
  console.log(`\n${summary}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=similarity (${MODEL})::${summary}`);
}

main().catch((error: unknown) => {
  console.error(error);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=similarity::${String(error)}`);
});
