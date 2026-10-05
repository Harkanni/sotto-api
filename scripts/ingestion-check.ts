/**
 * Phase 4's "done when", end to end against the real services: a PDF and a 30-minute recording
 * go in through the api the way the browser sends them (presigned multipart PUTs straight to
 * storage), travel the real queue through the worker and the transcriber (faster-whisper), and
 * must reach Ready with the right page numbers and the right timestamps.
 *
 * CI's `ingestion` job runs it after starting the images; nothing here is mocked. It needs only
 * Node 24 (types are stripped on load) and these:
 *   API_URL       the api, e.g. http://localhost:4000 (also its APP_URL, for the Origin header)
 *   MAILPIT_URL   Mailpit's web API, where the magic link lands
 *   MEETING_FILE  the recording (CI speaks sentences at 0:03, 20:30 and 29:30 into 30 minutes)
 *   READY_TIMEOUT_S  how long to wait for each file (default 1200)
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const API = process.env.API_URL ?? 'http://localhost:4000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const MEETING = process.env.MEETING_FILE ?? '/tmp/meeting.ogg';
const TIMEOUT_MS = Number(process.env.READY_TIMEOUT_S ?? 1200) * 1000;
const EMAIL = `ingestion-${Date.now()}@ci.example`;

interface FileRow {
  id: string;
  title: string;
  status: string;
  progress: number | null;
  error: string | null;
  durationMs: number | null;
  pageCount: number | null;
}

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  (${detail})` : ''}`);
  if (!ok) {
    failures += 1;
    // GitHub shows these on the PR without opening the log.
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=ingestion::${what} ${detail}`);
  }
}

// --- a tiny browser: cookies, the app's Origin, the CSRF token --------------------------------

const jar = new Map<string, string>();
let csrf = '';

function keep(res: Response): void {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair!.indexOf('=');
    jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim());
  }
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    origin: API,
    'sec-fetch-site': 'same-origin',
  };
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(new URL(path, API), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  keep(res);
  return res;
}

async function json<T>(method: string, path: string, body?: unknown, expected = 200): Promise<T> {
  const res = await call(method, path, body);
  const text = await res.text();
  if (res.status !== expected) {
    throw new Error(
      `${method} ${path} → ${res.status} (wanted ${expected}): ${text.slice(0, 300)}`,
    );
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Signs up with a magic link read from Mailpit, then makes a workspace to upload into. */
async function signIn(): Promise<void> {
  await json('POST', '/api/auth/sign-in/magic-link', {
    email: EMAIL,
    callbackURL: '/home',
    newUserCallbackURL: '/welcome',
  });
  let link = '';
  for (let i = 0; i < 30 && !link; i += 1) {
    const found = (await (
      await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${EMAIL}`)}`)
    ).json()) as { messages: { ID: string }[] };
    if (found.messages[0]) {
      const message = (await (
        await fetch(`${MAILPIT}/api/v1/message/${found.messages[0].ID}`)
      ).json()) as { Text: string };
      link = /https?:\/\/\S+/.exec(message.Text)?.[0] ?? '';
    }
    if (!link) await sleep(500);
  }
  if (!link) throw new Error(`No magic link reached Mailpit for ${EMAIL}`);
  const verified = await call('GET', new URL(link).pathname + new URL(link).search);
  if (verified.status !== 302) throw new Error(`The magic link answered ${verified.status}`);
  csrf = (await json<{ csrfToken: string }>('GET', '/api/v1/me')).csrfToken;
  await json('PATCH', '/api/v1/me', { name: 'Ingestion check' });
  await json('POST', '/api/v1/workspaces', { name: 'Ingestion CI' }, 201);
  csrf = (await json<{ csrfToken: string }>('GET', '/api/v1/me')).csrfToken;
}

/** The browser's whole upload: start, PUT each part to storage (more URLs as needed), complete. */
async function upload(filename: string, bytes: Buffer): Promise<FileRow> {
  const start = await json<{
    file: FileRow;
    partSize: number;
    partCount: number;
    parts: { partNumber: number; url: string }[];
  }>('POST', '/api/v1/uploads', { filename, sizeBytes: bytes.length }, 201);
  const urls = new Map(start.parts.map((p) => [p.partNumber, p.url]));
  const missing = Array.from({ length: start.partCount }, (_, i) => i + 1).filter(
    (n) => !urls.has(n),
  );
  if (missing.length) {
    const more = await json<{ parts: { partNumber: number; url: string }[] }>(
      'POST',
      `/api/v1/uploads/${start.file.id}/parts`,
      { partNumbers: missing },
    );
    for (const p of more.parts) urls.set(p.partNumber, p.url);
  }
  const parts: { partNumber: number; etag: string }[] = [];
  for (let n = 1; n <= start.partCount; n += 1) {
    const slice = bytes.subarray((n - 1) * start.partSize, n * start.partSize);
    const res = await fetch(urls.get(n)!, { method: 'PUT', body: new Uint8Array(slice) });
    if (!res.ok) throw new Error(`PUT part ${n} of ${filename} → ${res.status}`);
    parts.push({ partNumber: n, etag: res.headers.get('etag')! });
  }
  console.log(`      ${filename}: ${start.partCount} part(s) of ${start.partSize} bytes`);
  return json<FileRow>('POST', `/api/v1/uploads/${start.file.id}/complete`, { parts });
}

/** Polls the file until it's Ready (or Failed), printing each step it passes through. */
async function untilSettled(file: FileRow): Promise<FileRow> {
  const began = Date.now();
  let last = '';
  for (;;) {
    const now = await json<FileRow>('GET', `/api/v1/files/${file.id}`);
    const step = `${now.status}${now.progress != null ? ` ${Math.round(now.progress * 100)}%` : ''}`;
    if (step !== last) {
      console.log(`      ${file.title}: ${step} at ${Math.round((Date.now() - began) / 1000)} s`);
      last = step;
    }
    if (now.status === 'ready' || now.status === 'failed') return now;
    if (Date.now() - began > TIMEOUT_MS) return now;
    await sleep(2000);
  }
}

/** A real, minimal PDF with one line per page (the worker tests build the same). */
function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objects.length + 1 + pages.length * 2;
  const kids: number[] = [];
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
      ),
    );
  }
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// --- the checks -------------------------------------------------------------------------------

const PAGES = [
  'Field research findings: page one covers Lagos.',
  'Page two covers Nairobi and the offline recorder.',
  'Page three lists the open questions for the board.',
];

/** Spoken by CI at these offsets; the second sits past the transcriber's 20-minute window. */
const SPOKEN = [
  { atMs: 3_000, label: 'opening (0:03)' },
  { atMs: 20 * 60_000 + 30_000, label: 'second window (20:30)' },
  { atMs: 29 * 60_000 + 30_000, label: 'closing (29:30)' },
];

const mmss = (ms: number) =>
  `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

async function checkPdf(): Promise<void> {
  const file = await untilSettled(await upload('Field research findings.pdf', makePdf(PAGES)));
  check(file.status === 'ready', 'PDF reaches Ready', file.error ?? file.status);
  check(file.pageCount === 3, 'PDF has 3 pages', `pageCount ${file.pageCount}`);
  if (file.status !== 'ready') return;
  const content = await json<{ paged: boolean; pages: { page: number; text: string }[] }>(
    'GET',
    `/api/v1/files/${file.id}/content`,
  );
  check(content.paged, 'PDF content is paged');
  PAGES.forEach((text, i) => {
    const page = content.pages[i];
    check(
      page?.page === i + 1 && page.text.includes(text.slice(0, 20)),
      `page ${i + 1} holds its own text`,
      page ? `page ${page.page}: "${page.text.slice(0, 50)}"` : 'missing',
    );
  });
}

async function checkMeeting(): Promise<void> {
  const bytes = readFileSync(MEETING);
  const file = await untilSettled(await upload(basename(MEETING), bytes));
  check(file.status === 'ready', 'recording reaches Ready', file.error ?? file.status);
  check(
    file.durationMs != null && Math.abs(file.durationMs - 30 * 60_000) < 5_000,
    'recording is 30 minutes long',
    `durationMs ${file.durationMs}`,
  );
  if (file.status !== 'ready') return;

  const transcript = await json<{
    engine: string;
    isMock: boolean;
    segments: { startMs: number; endMs: number; text: string }[];
  }>('GET', `/api/v1/files/${file.id}/transcript`);
  check(
    transcript.engine.startsWith('faster-whisper') && !transcript.isMock,
    'transcribed by faster-whisper, not a mock',
    `${transcript.engine}, isMock ${transcript.isMock}`,
  );
  for (const s of transcript.segments) console.log(`      ${mmss(s.startMs)}  ${s.text}`);
  for (const { atMs, label } of SPOKEN) {
    // Whisper places a segment within a second or two of the speech; VAD trims the silence.
    const near = transcript.segments.find(
      (s) => s.startMs >= atMs - 3_000 && s.startMs <= atMs + 8_000,
    );
    check(Boolean(near), `a segment starts at the ${label}`, near ? mmss(near.startMs) : 'none');
  }
  const heard = transcript.segments.map((s) => s.text.toLowerCase()).join(' ');
  check(heard.includes('friday'), 'the closing words are heard', '"friday"');
  const stray = transcript.segments.filter(
    (s) => !SPOKEN.some(({ atMs }) => s.startMs >= atMs - 3_000 && s.startMs <= atMs + 15_000),
  );
  check(stray.length === 0, 'no text invented in the silence', `${stray.length} stray segment(s)`);

  const found = await json<{ matches: { idx: number }[] | null }>(
    'GET',
    `/api/v1/files/${file.id}/transcript?q=friday`,
  );
  check((found.matches?.length ?? 0) > 0, 'transcript search finds "friday"');
  const peaks = await call('GET', `/api/v1/files/${file.id}/peaks`);
  check(peaks.status === 200, 'waveform peaks are stored', `GET peaks → ${peaks.status}`);
  const insights = await call('GET', `/api/v1/files/${file.id}/insights`);
  check(insights.status === 200, 'meeting notes are written', `GET insights → ${insights.status}`);
}

await signIn();
console.log(`signed in as ${EMAIL}`);
// Both at once, the way a person drops them together.
await Promise.all([checkPdf(), checkMeeting()]);
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
