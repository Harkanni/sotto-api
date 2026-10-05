import type { FileKind } from '@sotto/db';

/**
 * What Sotto reads (BRIEF §4): PDF (keeping pages), Word, plain text, Markdown, and audio.
 * Browsers record in different containers: Chrome and Firefox WebM/Opus, Safari MP4/AAC
 * ("audio/mp4", saved as .m4a or .mp4). The transcriber normalises every one with ffmpeg.
 */
const FORMATS: Record<string, { kind: FileKind; mime: string }> = {
  '.pdf': { kind: 'DOCUMENT', mime: 'application/pdf' },
  '.docx': {
    kind: 'DOCUMENT',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  '.txt': { kind: 'DOCUMENT', mime: 'text/plain' },
  '.md': { kind: 'DOCUMENT', mime: 'text/markdown' },
  '.markdown': { kind: 'DOCUMENT', mime: 'text/markdown' },
  '.mp3': { kind: 'AUDIO', mime: 'audio/mpeg' },
  '.m4a': { kind: 'AUDIO', mime: 'audio/mp4' },
  '.mp4': { kind: 'AUDIO', mime: 'audio/mp4' },
  '.aac': { kind: 'AUDIO', mime: 'audio/aac' },
  '.wav': { kind: 'AUDIO', mime: 'audio/wav' },
  '.webm': { kind: 'AUDIO', mime: 'audio/webm' },
  '.ogg': { kind: 'AUDIO', mime: 'audio/ogg' },
  '.oga': { kind: 'AUDIO', mime: 'audio/ogg' },
  '.opus': { kind: 'AUDIO', mime: 'audio/ogg' },
  '.flac': { kind: 'AUDIO', mime: 'audio/flac' },
};

/** Audio MIME types browsers report, for recordings that arrive without a useful extension. */
const AUDIO_MIME = /^audio\/(mpeg|mp4|aac|x-m4a|wav|x-wav|wave|webm|ogg|flac|x-flac)\b/;
const VIDEO_AUDIO = /^video\/(webm|mp4)\b/; // MediaRecorder sometimes labels audio-only as video

export const ACCEPTED_EXTENSIONS = Object.keys(FORMATS);

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return match ? `.${match[1]!.toLowerCase()}` : '';
}

/**
 * Decides what an upload is from its name, falling back to the browser's MIME type. Returns null
 * for anything Sotto can't read, so the api refuses it before any bytes move.
 */
export function formatOf(filename: string, mime?: string): { kind: FileKind; mime: string } | null {
  const byExtension = FORMATS[extensionOf(filename)];
  if (byExtension) return byExtension;
  const type = (mime ?? '').toLowerCase();
  if (AUDIO_MIME.test(type)) return { kind: 'AUDIO', mime: type.split(';')[0]! };
  if (VIDEO_AUDIO.test(type))
    return { kind: 'AUDIO', mime: type.replace('video/', 'audio/').split(';')[0]! };
  return null;
}

/** A title from a file name: no extension, separators read as spaces, trimmed to 120 chars. */
export function titleFrom(filename: string): string {
  const base = filename
    .replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || 'Untitled').slice(0, 120);
}
