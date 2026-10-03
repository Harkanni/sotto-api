import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

/** Text from one page of a PDF, or the whole of a format without pages (page 1). */
export interface Page {
  page: number;
  text: string;
}

export interface Extracted {
  pages: Page[];
  /** Real page numbers exist only for PDFs; other formats are one flowing text. */
  paged: boolean;
}

/** A reason processing stopped, as a code the web turns into words (never document content). */
export class ExtractError extends Error {
  constructor(readonly code: 'unreadable' | 'encrypted' | 'no_text' | 'unsupported') {
    super(code);
    this.name = 'ExtractError';
  }
}

/** Collapses runs of spaces and blank lines; keeps paragraph breaks, which chunking relies on. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v\u00a0]+/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

async function pdf(bytes: Uint8Array): Promise<Extracted> {
  let doc;
  try {
    doc = await getDocumentProxy(bytes);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    throw new ExtractError(name === 'PasswordException' ? 'encrypted' : 'unreadable');
  }
  try {
    const { text } = await extractText(doc, { mergePages: false });
    return { pages: text.map((t, i) => ({ page: i + 1, text: tidy(t) })), paged: true };
  } finally {
    // Frees the parser’s memory (fonts, page caches) and its worker.
    await doc.loadingTask.destroy().catch(() => undefined);
  }
}

async function docx(bytes: Uint8Array): Promise<Extracted> {
  try {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return { pages: [{ page: 1, text: tidy(value) }], paged: false };
  } catch {
    throw new ExtractError('unreadable');
  }
}

function plain(bytes: Uint8Array): Extracted {
  // fatal: a binary file renamed .txt shouldn't be indexed as mojibake.
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  return { pages: [{ page: 1, text: tidy(text.replace(/^\uFEFF/, '')) }], paged: false };
}

/** Reads a document's text by its MIME type (set by the api from the file's extension). */
export async function extract(bytes: Uint8Array, mime: string): Promise<Extracted> {
  let out: Extracted;
  if (mime === 'application/pdf') out = await pdf(bytes);
  else if (mime.includes('wordprocessingml')) out = await docx(bytes);
  else if (mime === 'text/plain' || mime === 'text/markdown') out = plain(bytes);
  else throw new ExtractError('unsupported');
  // A scanned PDF has pages but no text layer; OCR is out of scope for now (BRIEF lists it
  // under PDF tooling, not the MVP), so say so instead of indexing nothing.
  if (!out.pages.some((p) => p.text.length > 0)) throw new ExtractError('no_text');
  return out;
}
