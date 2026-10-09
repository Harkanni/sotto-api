/**
 * Phase 5's eval set, end to end against the real services (CI's `evals` job; or any running
 * stack): an owner signs up, loads the fictional sample content, waits until the worker has
 * indexed it (with whatever embedding model the stack runs), invites a viewer, then every
 * question in evals/kestrel.ts is searched and asked through the api by both. evals/score.ts
 * scores it and decides pass or fail; the summary goes to the job page.
 *
 * Needs only Node 24 (types are stripped on load) and:
 *   API_URL       the api, e.g. http://localhost:4000 (also its APP_URL, for the Origin header)
 *   MAILPIT_URL   Mailpit's web API, where magic links land
 *   READY_TIMEOUT_S  how long to wait for the sample content (default 600)
 */
import { appendFileSync } from 'node:fs';
import {
  type AnswerResult,
  type Client,
  type SearchResult,
  markdown,
  runEval,
} from '../evals/score.ts';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const TIMEOUT_MS = Number(process.env.READY_TIMEOUT_S ?? 600) * 1000;
const RUN = Date.now();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tiny browser: its own cookies, the app's Origin, the CSRF token. */
class Session {
  private readonly jar = new Map<string, string>();
  private csrf = '';
  readonly email: string;

  constructor(email: string) {
    this.email = email;
  }

  async call(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      origin: API,
      'sec-fetch-site': 'same-origin',
    };
    if (method !== 'GET') headers['x-csrf-token'] = this.csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(new URL(path, API), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair!.indexOf('=');
      this.jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim());
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> {
    const res = await this.call(method, path, body);
    const text = await res.text();
    if (res.status !== expected) {
      throw new Error(
        `${method} ${path} → ${res.status} (wanted ${expected}): ${text.slice(0, 300)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async refresh(): Promise<void> {
    this.csrf = (await this.json<{ csrfToken: string }>('GET', '/api/v1/me')).csrfToken;
  }

  /** Signs in (or up) with a magic link read from Mailpit. */
  async signIn(name: string): Promise<void> {
    await this.json('POST', '/api/auth/sign-in/magic-link', {
      email: this.email,
      callbackURL: '/home',
      newUserCallbackURL: '/welcome',
    });
    let link = '';
    for (let i = 0; i < 30 && !link; i += 1) {
      const found = (await (
        await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${this.email}`)}`)
      ).json()) as { messages: { ID: string }[] };
      for (const m of found.messages) {
        const message = (await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) as {
          Text: string;
        };
        const url = /https?:\/\/\S+/.exec(message.Text)?.[0] ?? '';
        if (url.includes('magic-link')) {
          link = url;
          break;
        }
      }
      if (!link) await sleep(500);
    }
    if (!link) throw new Error(`No magic link reached Mailpit for ${this.email}`);
    const verified = await this.call('GET', new URL(link).pathname + new URL(link).search);
    if (verified.status !== 302) throw new Error(`The magic link answered ${verified.status}`);
    await this.refresh();
    await this.json('PATCH', '/api/v1/me', { name });
  }

  client(): Client {
    return {
      search: async (question) => {
        type Hit = {
          rank: number;
          file: { title: string };
          page?: number | null;
          startMs?: number;
          endMs?: number;
        };
        const body = await this.json<{
          mode: 'hybrid' | 'keyword';
          files: { file: { title: string } }[];
          passages: Hit[];
          moments: Hit[];
        }>('GET', `/api/v1/search?q=${encodeURIComponent(question)}`);
        const result: SearchResult = {
          mode: body.mode,
          files: body.files.map((f) => f.file.title),
          hits: [...body.passages, ...body.moments].map((h) => ({
            rank: h.rank,
            title: h.file.title,
            page: h.page ?? null,
            startMs: h.startMs ?? null,
            endMs: h.endMs ?? null,
          })),
        };
        return result;
      },
      ask: async (question) => {
        const chat = await this.json<{ id: string }>('POST', '/api/v1/conversations', {}, 201);
        const res = await this.call('POST', `/api/v1/conversations/${chat.id}/messages`, {
          content: question,
        });
        const text = await res.text();
        if (res.status !== 200) throw new Error(`Ask → ${res.status}: ${text.slice(0, 300)}`);
        const done = text
          .split('\n\n')
          .find((b) => b.startsWith('event: done'))
          ?.split('\ndata: ')[1];
        if (!done) throw new Error(`The answer didn't finish: ${text.slice(-300)}`);
        return (JSON.parse(done) as { answer: AnswerResult }).answer;
      },
    };
  }
}

async function main(): Promise<void> {
  const owner = new Session(`amaka-${RUN}@evals.example`);
  await owner.signIn('Amaka (evals)');
  await owner.json('POST', '/api/v1/workspaces', { name: 'Kestrel Labs (evals)' }, 201);
  await owner.refresh();
  await owner.json('POST', '/api/v1/onboarding/sample-content');

  // Wait for the worker to index every sample file with the stack's embedding model.
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const page = await owner.json<{
      items: { title: string; status: string; error: string | null }[];
    }>('GET', '/api/v1/files?limit=100');
    const waiting = page.items.filter((f) => f.status !== 'ready');
    const failed = waiting.filter((f) => f.status === 'failed');
    if (failed.length) {
      throw new Error(
        `Sample files failed: ${failed.map((f) => `${f.title} (${f.error})`).join(', ')}`,
      );
    }
    if (page.items.length && !waiting.length) {
      console.log(`${page.items.length} sample files ready`);
      break;
    }
    if (Date.now() > deadline)
      throw new Error(`Still processing: ${waiting.map((f) => f.title).join(', ')}`);
    await sleep(2_000);
  }

  const viewer = new Session(`priya-${RUN}@evals.example`);
  const invite = await owner.json<{ id: string }>(
    'POST',
    '/api/v1/invites',
    { email: viewer.email, role: 'viewer' },
    201,
  );
  await viewer.signIn('Priya (evals)');
  await viewer.json('POST', `/api/v1/invites/${invite.id}/accept`);
  await viewer.refresh();

  const report = await runEval({
    owner: owner.client(),
    viewer: viewer.client(),
    log: (line) => console.log(line),
  });
  const summary = markdown(report);
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (!report.passed) {
    for (const failure of report.failures) {
      if (process.env.GITHUB_ACTIONS) console.log(`::error title=evals::${failure}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=evals::${String(error)}`);
  process.exitCode = 1;
});
