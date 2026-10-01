import { Queues } from '@sotto/contracts';
import { describe, expect, it } from 'vitest';
import { decide } from '../src/consumer.js';

const valid = {
  v: 1,
  fileId: 'f1',
  workspaceId: 'w1',
  kind: 'DOCUMENT',
  storageKey: 'w1/f1.pdf',
  mime: 'application/pdf',
};

describe('decide', () => {
  it('acks a valid message', () => {
    const decision = decide(Queues.fileUploaded, Buffer.from(JSON.stringify(valid)));
    expect(decision).toEqual({ action: 'ack', message: valid });
  });

  it('rejects malformed JSON', () => {
    expect(decide(Queues.fileUploaded, Buffer.from('{nope'))).toEqual({
      action: 'reject',
      reason: 'invalid_json',
    });
  });

  it('rejects the wrong shape', () => {
    const decision = decide(Queues.fileUploaded, Buffer.from(JSON.stringify({ v: 1 })));
    expect(decision).toEqual({ action: 'reject', reason: 'invalid_shape' });
  });
});
