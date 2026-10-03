import { describe, expect, it } from 'vitest';
import {
  Derived,
  ObjectMissingError,
  S3_MAX_PARTS,
  S3_MIN_PART,
  Storage,
  StorageKeys,
  extensionOf,
  partCountFor,
  partSizeFor,
  storageEnv,
} from '../src/index.js';

const MiB = 1024 * 1024;

describe('keys', () => {
  const keys = new StorageKeys('files');

  it('puts every object of a file under one prefix', () => {
    expect(keys.file('w1', 'f1')).toBe('files/w1/f1/');
    expect(keys.original('w1', 'f1', 'Board pack Q3.PDF')).toBe('files/w1/f1/original.pdf');
    expect(keys.original('w1', 'f1', 'notes')).toBe('files/w1/f1/original');
    expect(keys.derived('w1', 'f1', Derived.transcript)).toBe('files/w1/f1/transcript.json');
  });

  it('refuses ids that could escape the prefix', () => {
    expect(() => keys.file('../w2', 'f1')).toThrow(/workspace id/);
    expect(() => keys.file('w1', 'f1/../../x')).toThrow(/file id/);
  });

  it('keeps only short, plain extensions', () => {
    expect(extensionOf('a.tar.gz')).toBe('.gz');
    expect(extensionOf('weird.<script>')).toBe('');
    expect(extensionOf('.m4a')).toBe('.m4a');
  });
});

describe('multipart sizing', () => {
  it('uses 8 MiB parts for ordinary files', () => {
    expect(partSizeFor(1)).toBe(8 * MiB);
    expect(partSizeFor(500 * MiB)).toBe(8 * MiB);
    expect(partCountFor(500 * MiB, 8 * MiB)).toBe(63);
    expect(partCountFor(0, 8 * MiB)).toBe(1);
  });

  it('grows parts for very large files, within S3’s limits', () => {
    for (const size of [10 * 1024 * MiB, 50 * 1024 * MiB]) {
      const part = partSizeFor(size);
      expect(part).toBeGreaterThanOrEqual(S3_MIN_PART);
      expect(partCountFor(size, part)).toBeLessThanOrEqual(1_000);
      expect(partCountFor(size, part)).toBeLessThan(S3_MAX_PARTS);
    }
  });
});

/** Against a real S3-compatible server when one is configured (CI: SeaweedFS; locally: any). */
const endpoint = process.env.TEST_S3_ENDPOINT;
describe.skipIf(!endpoint)('Storage against S3', () => {
  const storage = new Storage(
    storageEnv.parse({
      S3_ENDPOINT: endpoint,
      S3_BUCKET: process.env.TEST_S3_BUCKET ?? 'sotto-test',
      S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID ?? 'test',
      S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'test',
    }),
  );
  const id = `t${Date.now().toString(36)}`;

  it('uploads in parts through presigned URLs, resumes, completes and deletes', async () => {
    const key = storage.keys.original('wtest', id, 'big.bin');
    const uploadId = await storage.createMultipart(key, 'application/octet-stream');
    const part1 = Buffer.alloc(S3_MIN_PART, 1);
    const part2 = Buffer.from('the end');
    const urls = await storage.presignParts(key, uploadId, [1, 2]);
    expect(urls.map((u) => u.partNumber)).toEqual([1, 2]);

    // The browser's side: plain PUTs, no credentials.
    const put = async (url: string, body: Buffer) => {
      const res = await fetch(url, { method: 'PUT', body });
      expect(res.status).toBe(200);
      return res.headers.get('etag')!;
    };
    const etag1 = await put(urls[0]!.url, part1);

    // After an interruption, storage says what it already has.
    const listed = await storage.listParts(key, uploadId);
    expect(listed.map((p) => p.partNumber)).toEqual([1]);

    const [again] = await storage.presignParts(key, uploadId, [2]);
    const etag2 = await put(again!.url, part2);
    await storage.completeMultipart(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);
    expect((await storage.head(key)).size).toBe(part1.length + part2.length);

    const url = await storage.presignGet(key, { filename: 'Big file.bin' });
    const res = await fetch(url, { headers: { range: 'bytes=-7' } });
    expect(await res.text()).toBe('the end');

    await storage.putJson(storage.keys.derived('wtest', id, Derived.pages), { pages: [] });
    expect(await storage.deletePrefix(storage.keys.file('wtest', id))).toBe(2);
    await expect(storage.head(key)).rejects.toBeInstanceOf(ObjectMissingError);
  });

  it('never deletes more than one file’s prefix', async () => {
    await expect(storage.deletePrefix('files/')).rejects.toThrow(/wider than one file/);
    await expect(storage.deletePrefix('files/wtest/')).rejects.toThrow(/wider than one file/);
  });
});
