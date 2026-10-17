/**
 * The audio format every live capture uses on the wire and in storage: 16 kHz mono signed
 * 16-bit little-endian PCM. It's what the transcriber wants anyway (it normalises everything to
 * it), it needs no decoder on either side, and its length is its duration: 32 bytes a
 * millisecond. The browser converts with an AudioWorklet; the Meet bot does the same.
 */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1_000; // 32

/** The longest chunk accepted: clients send about every 4 s, so 15 s leaves room for a retry. */
export const MAX_CHUNK_MS = 15_000;
export const MAX_CHUNK_BYTES = MAX_CHUNK_MS * BYTES_PER_MS;

/** Audio can't arrive much faster than it's spoken: a client may catch up after a drop, no more. */
export const AHEAD_ALLOWANCE_MS = 2 * 60_000;

/** A live capture that has sent nothing for this long is ended for you (tab closed, laptop shut). */
export const IDLE_END_MS = 10 * 60_000;

/** The longest live capture: long workshops fit; a forgotten tab doesn't record all day. */
export const MAX_SESSION_MS = 6 * 60 * 60_000;

export function msOf(bytes: number): number {
  return Math.round(bytes / BYTES_PER_MS);
}

/** A 44-byte RIFF/WAVE header for `dataBytes` of 16 kHz mono PCM16. */
export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per sample frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function toWav(pcm: Buffer): Buffer {
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}
