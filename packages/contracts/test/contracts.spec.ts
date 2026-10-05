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

describe('Phase 4 contracts', () => {
  it('reads transcription progress and keeps it in range', async () => {
    const { TranscribeProgress } = await import('../src/index.js');
    expect(
      TranscribeProgress.parse({ v: 1, fileId: 'f', workspaceId: 'w', progress: 0.5 }),
    ).toBeTruthy();
    expect(() =>
      TranscribeProgress.parse({ v: 1, fileId: 'f', workspaceId: 'w', progress: 2 }),
    ).toThrow();
  });

  it('accepts an older transcribe.requested without the new optional fields', async () => {
    const { TranscribeRequested } = await import('../src/index.js');
    const msg = { v: 1, fileId: 'f', workspaceId: 'w', storageKey: 'k' };
    expect(TranscribeRequested.parse(msg)).toEqual(msg);
  });

  it('defaults isMock on stored transcripts and validates insights', async () => {
    const { TranscriptDocument, MeetingInsightsBody } = await import('../src/index.js');
    const t = TranscriptDocument.parse({
      engine: 'faster-whisper',
      model: 'base',
      language: 'en',
      durationMs: 1000,
      segments: [{ startMs: 0, endMs: 1000, text: 'Hello', speaker: null }],
    });
    expect(t.isMock).toBe(false);
    expect(
      MeetingInsightsBody.parse({
        summary: 's',
        decisions: [],
        actionItems: [{ text: 'Send the deck', owner: 'Tunde', due: null }],
        openQuestions: [],
        chapters: [{ title: 'Intro', startMs: 0 }],
      }).actionItems[0]!.owner,
    ).toBe('Tunde');
  });

  it('strips the filtering fields before an event reaches a browser', async () => {
    const { FileEvent, BrowserFileEvent, eventsChannel } = await import('../src/index.js');
    const event = FileEvent.parse({
      type: 'file',
      fileId: 'f',
      collectionId: 'c',
      ownerId: 'u',
      status: 'READY',
      progress: null,
      error: null,
      at: new Date().toISOString(),
    });
    expect(event.change).toBe('status');
    const out = BrowserFileEvent.parse(event);
    expect(out).not.toHaveProperty('collectionId');
    expect(out).not.toHaveProperty('ownerId');
    expect(eventsChannel('w1')).toBe('sotto:events:w1');
  });
});
