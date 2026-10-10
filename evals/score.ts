/**
 * Scores the eval set (./kestrel.ts) through a `Client`: anything that can search and ask as a
 * given person. The in-process test (apps/api/test/integration/evals.spec.ts) and the end-to-end
 * runner (scripts/eval.ts) both use it, so they measure the same things the same way:
 *
 *   retrieval  recall@1/3/5 and MRR over the files /search ranks (passages and moments
 *              interleaved by their fused rank), and whether a meeting's passage holds the
 *              moment the answer was said
 *   answers    with a model: does it cite a right file and say the key words; for questions
 *              nothing answers: does it say so instead of guessing
 *   access     a viewer without the Board and finance collection never gets its file, by
 *              search or by Ask, for any question
 *
 * Thresholds differ by search mode: keyword-only (mock embeddings) can't find paraphrases, and
 * the gate says what is expected of each.
 */
import { BOARD_TITLE, QUESTIONS, UNANSWERABLE, type EvalQuestion } from './kestrel.ts';

export interface SearchHit {
  rank: number;
  title: string;
  page: number | null;
  startMs: number | null;
  endMs: number | null;
}

export interface SearchResult {
  mode: 'hybrid' | 'keyword';
  /** Passages and moments together, best first. */
  hits: SearchHit[];
  /** File titles the search listed (by title or content). */
  files: string[];
}

export interface AnswerResult {
  content: string;
  notFound: boolean;
  passagesOnly: boolean;
  isMock: boolean;
  status: string;
  citations: { title: string | null; startMs: number | null }[];
}

export interface Client {
  search(question: string): Promise<SearchResult>;
  ask(question: string): Promise<AnswerResult>;
}

export interface Thresholds {
  recallAt5: number;
  mrr: number;
  place: number;
  unanswerable: number;
  cited: number;
  words: number;
}

export const THRESHOLDS: Record<'hybrid' | 'keyword', Thresholds> = {
  // Real embeddings (nomic-embed-text in CI): paraphrases must be found, and unrelated
  // questions must find nothing. Measured on 9 Oct 2026: recall@5 100%, MRR 0.92, moments 100%,
  // 3/3 declined, 96% cited; the gates sit just under that. `words` applies only with a model.
  hybrid: { recallAt5: 0.95, mrr: 0.85, place: 0.9, unanswerable: 1, cited: 0.9, words: 0.7 },
  // Keywords only (mock embeddings). Measured on 9 Oct 2026: recall@5 100%, MRR 0.63–0.65,
  // moments 88%, 3/3 declined; the gates sit just under that so a keyword regression fails.
  keyword: { recallAt5: 0.9, mrr: 0.55, place: 0.8, unanswerable: 1, cited: 0.9, words: 0.5 },
};

export interface QuestionResult {
  id: string;
  question: string;
  rank: number | null;
  placeOk: boolean | null;
  cited: boolean | null;
  words: boolean | null;
}

export interface Report {
  mode: 'hybrid' | 'keyword';
  model: 'real' | 'mock' | 'none';
  questions: QuestionResult[];
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  place: number;
  unanswerable: { asked: number; declined: number };
  cited: number | null;
  words: number | null;
  leaks: string[];
  failures: string[];
  passed: boolean;
}

const ms = (stamp: string) => {
  const [m, s] = stamp.split(':').map(Number);
  return (m! * 60 + s!) * 1000;
};

/** Distinct files in ranked order. */
function rankedFiles(result: SearchResult): string[] {
  return [...new Set([...result.hits].sort((a, b) => a.rank - b.rank).map((h) => h.title))];
}

const ratio = (n: number, of: number) => (of ? n / of : 1);

export async function runEval(input: {
  owner: Client;
  viewer: Client;
  log?: (line: string) => void;
}): Promise<Report> {
  const log = input.log ?? (() => undefined);
  const questions: QuestionResult[] = [];
  let mode: 'hybrid' | 'keyword' = 'hybrid';
  let model: Report['model'] = 'none';

  for (const q of QUESTIONS) {
    const found = await input.owner.search(q.question);
    if (found.mode === 'keyword') mode = 'keyword';
    const files = rankedFiles(found);
    const at = files.findIndex((f) => q.expect.includes(f));
    const rank = at === -1 ? null : at + 1;
    const placeOk = q.at ? placeHolds(found, q) : null;

    const answer = await input.owner.ask(q.question);
    model = answer.passagesOnly ? 'none' : answer.isMock ? 'mock' : 'real';
    let cited: boolean | null = null;
    let words: boolean | null = null;
    if (model !== 'mock') {
      cited = answer.citations.some((c) => c.title !== null && q.expect.includes(c.title));
    }
    if (model === 'real' && q.answer) {
      const text = answer.content.toLowerCase();
      words = q.answer.every((w) => text.includes(w.toLowerCase()));
    }
    questions.push({ id: q.id, question: q.question, rank, placeOk, cited, words });
    log(
      `${rank !== null && rank <= 5 ? 'ok  ' : 'MISS'}  ${q.id.padEnd(20)} rank ${rank ?? '-'}` +
        `${placeOk === null ? '' : `  place ${placeOk ? 'ok' : 'wrong'}`}` +
        `${cited === null ? '' : `  cited ${cited ? 'yes' : 'no'}`}` +
        `${words === null ? '' : `  words ${words ? 'yes' : 'no'}`}`,
    );
  }

  let declined = 0;
  for (const question of UNANSWERABLE) {
    const answer = await input.owner.ask(question);
    if (answer.notFound) declined += 1;
    log(`${answer.notFound ? 'ok  ' : 'MISS'}  unanswerable: ${question}`);
  }

  // The viewer: Board and finance is restricted and they have no grant.
  const leaks: string[] = [];
  for (const question of [...QUESTIONS.map((q) => q.question), ...UNANSWERABLE]) {
    const found = await input.viewer.search(question);
    if (found.files.includes(BOARD_TITLE) || found.hits.some((h) => h.title === BOARD_TITLE)) {
      leaks.push(`search: ${question}`);
    }
    const answer = await input.viewer.ask(question);
    if (answer.citations.some((c) => c.title === BOARD_TITLE)) leaks.push(`ask: ${question}`);
  }
  log(
    leaks.length
      ? `FAIL  viewer saw the board ${leaks.length} times`
      : 'ok    viewer never saw the board',
  );

  const n = questions.length;
  const within = (k: number) => questions.filter((r) => r.rank !== null && r.rank <= k).length;
  const placed = questions.filter((r) => r.placeOk !== null);
  const citedRows = questions.filter((r) => r.cited !== null);
  const wordRows = questions.filter((r) => r.words !== null);
  const report: Report = {
    mode,
    model,
    questions,
    recallAt1: ratio(within(1), n),
    recallAt3: ratio(within(3), n),
    recallAt5: ratio(within(5), n),
    mrr: questions.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n,
    place: ratio(placed.filter((r) => r.placeOk).length, placed.length),
    unanswerable: { asked: UNANSWERABLE.length, declined },
    cited: citedRows.length
      ? ratio(citedRows.filter((r) => r.cited).length, citedRows.length)
      : null,
    words: wordRows.length ? ratio(wordRows.filter((r) => r.words).length, wordRows.length) : null,
    leaks,
    failures: [],
    passed: false,
  };

  const t = THRESHOLDS[mode];
  const gate = (ok: boolean, what: string) => ok || report.failures.push(what);
  gate(report.recallAt5 >= t.recallAt5, `recall@5 ${pct(report.recallAt5)} < ${pct(t.recallAt5)}`);
  gate(report.mrr >= t.mrr, `MRR ${report.mrr.toFixed(2)} < ${t.mrr}`);
  gate(report.place >= t.place, `meeting moments ${pct(report.place)} < ${pct(t.place)}`);
  gate(
    ratio(declined, UNANSWERABLE.length) >= t.unanswerable,
    `unanswerable declined ${declined}/${UNANSWERABLE.length}`,
  );
  if (report.cited !== null)
    gate(report.cited >= t.cited, `cited a right file ${pct(report.cited)}`);
  if (report.words !== null) gate(report.words >= t.words, `answer words ${pct(report.words)}`);
  gate(leaks.length === 0, `a viewer reached the restricted board update (${leaks.length})`);
  report.passed = report.failures.length === 0;
  return report;
}

/** A meeting answer's moment sits inside one of that file's top three passages. */
function placeHolds(found: SearchResult, q: EvalQuestion): boolean {
  const target = ms(q.at!);
  return [...found.hits]
    .sort((a, b) => a.rank - b.rank)
    .filter((h) => q.expect.includes(h.title) && h.startMs !== null)
    .slice(0, 3)
    .some((h) => h.startMs! <= target && target <= (h.endMs ?? h.startMs!));
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A Markdown summary for the CI job page. */
export function markdown(report: Report): string {
  const t = THRESHOLDS[report.mode];
  const rows = report.questions
    .map(
      (r) =>
        `| ${r.id} | ${r.rank ?? '–'} | ${r.placeOk === null ? '' : r.placeOk ? '✓' : '✗'} | ${
          r.cited === null ? '' : r.cited ? '✓' : '✗'
        } | ${r.words === null ? '' : r.words ? '✓' : '✗'} |`,
    )
    .join('\n');
  return `## Ask and search evals: ${report.passed ? 'passed' : 'FAILED'}

Search: **${report.mode}**. Answers: **${
    report.model === 'none'
      ? 'passages only (no chat model)'
      : report.model === 'mock'
        ? 'mock model (not scored)'
        : 'a real model'
  }**.

| Measure | Result | Gate |
| --- | --- | --- |
| Recall@1 / @3 / @5 | ${pct(report.recallAt1)} / ${pct(report.recallAt3)} / ${pct(report.recallAt5)} | @5 ≥ ${pct(t.recallAt5)} |
| MRR | ${report.mrr.toFixed(2)} | ≥ ${t.mrr} |
| Meeting moment found | ${pct(report.place)} | ≥ ${pct(t.place)} |
| Unanswerable declined | ${report.unanswerable.declined}/${report.unanswerable.asked} | ≥ ${pct(t.unanswerable)} |
| Answer cites a right file | ${report.cited === null ? '–' : pct(report.cited)} | ≥ ${pct(t.cited)} |
| Answer has the key words | ${report.words === null ? '–' : pct(report.words)} | ≥ ${pct(t.words)} |
| Viewer reached the board | ${report.leaks.length} | 0 |

${report.failures.length ? `Failed: ${report.failures.join('; ')}.\n\n` : ''}| Question | Rank | Moment | Cited | Words |
| --- | --- | --- | --- | --- |
${rows}
`;
}
