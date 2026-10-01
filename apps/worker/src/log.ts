type Level = 'debug' | 'info' | 'warn' | 'error';

const json = process.env.NODE_ENV === 'production';

/**
 * Minimal structured logger. Fields must never include document text, prompts, answers or keys —
 * ids and counts only.
 */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = json
    ? JSON.stringify({
        level,
        time: new Date().toISOString(),
        service: 'sotto-worker',
        message,
        ...fields,
      })
    : `[worker] ${level.toUpperCase()} ${message}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}
