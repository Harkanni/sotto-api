import { messageSchemas, type QueueName } from '@sotto/contracts';

export type Decision<T = unknown> =
  | { action: 'ack'; message: T }
  | { action: 'reject'; reason: 'invalid_json' | 'invalid_shape' };

/**
 * Validate a raw queue payload against its contract. Invalid messages are rejected without
 * requeueing (they'd fail forever); a dead-letter queue collects them from Phase 4.
 */
export function decide(queue: QueueName, raw: Buffer): Decision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { action: 'reject', reason: 'invalid_json' };
  }
  const result = messageSchemas[queue].safeParse(parsed);
  return result.success
    ? { action: 'ack', message: result.data }
    : { action: 'reject', reason: 'invalid_shape' };
}
