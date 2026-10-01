import { describe, expect, it } from 'vitest';
import { FileUploaded, messageSchemas, Queues, TranscribeCompleted } from '../src/index.js';

describe('queue contracts', () => {
  it('accepts a valid file.uploaded message', () => {
    const msg = {
      v: 1,
      fileId: 'f1',
      workspaceId: 'w1',
      kind: 'AUDIO',
      storageKey: 'w1/f1.webm',
      mime: 'audio/webm',
    };
    expect(FileUploaded.parse(msg)).toEqual(msg);
  });

  it('rejects an unknown version', () => {
    expect(() => FileUploaded.parse({ v: 2 })).toThrow();
  });

  it('separates ok and failed transcriptions', () => {
    const failed = TranscribeCompleted.parse({
      v: 1,
      status: 'failed',
      fileId: 'f1',
      workspaceId: 'w1',
      engine: 'fake',
      error: 'decode_error',
    });
    expect(failed.status).toBe('failed');
  });

  it('has a schema for every queue', () => {
    for (const name of Object.values(Queues)) expect(messageSchemas[name]).toBeDefined();
  });
});
