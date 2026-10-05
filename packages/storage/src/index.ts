/**
 * Object storage for uploaded files and what the pipeline derives from them. S3 on AWS,
 * SeaweedFS (or any S3-compatible server) locally. The api and the worker share this module; the
 * browser only ever sees short-lived presigned URLs, never credentials.
 */
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { z } from 'zod';

const blankAsUnset = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optional = z.preprocess(blankAsUnset, z.string().trim().optional());

/** Storage settings, shared by every service that touches files. */
export const storageEnv = z.object({
  S3_BUCKET: z.string().min(1).default('sotto-files'),
  S3_REGION: z.string().min(1).default('eu-west-2'),
  /** Where services reach storage. Unset on AWS (the SDK picks the regional endpoint). */
  S3_ENDPOINT: optional,
  /**
   * Where browsers reach it, if different (Compose: services use http://s3:8333, the browser
   * http://localhost:8333). Presigned URLs are signed for this host.
   */
  S3_PUBLIC_ENDPOINT: optional,
  /** Path-style URLs (http://host/bucket/key) for servers without virtual-host buckets. */
  S3_FORCE_PATH_STYLE: z.preprocess(blankAsUnset, z.enum(['true', 'false']).optional()),
  /** Static keys for local servers. On AWS leave unset: the instance role signs requests. */
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  /** Everything Sotto writes lives under this prefix (the dev bucket shares other prefixes). */
  S3_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .default('files'),
});
export type StorageConfig = z.infer<typeof storageEnv>;

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────

/** What the pipeline writes next to an original, by name. */
export const Derived = {
  /** Extracted text by page: `{ pages: [{ page, text }] }`. */
  pages: 'pages.json',
  /** The transcriber's output, read once by the worker. */
  transcript: 'transcript.json',
  /** Waveform peaks for the player's scrubber. */
  peaks: 'peaks.json',
} as const;
export type DerivedName = (typeof Derived)[keyof typeof Derived];

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function safeId(kind: string, value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${kind} for a storage key`);
  return value;
}

/** A lowercase extension from a file name, or '' when there isn't a sensible one. */
export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return match ? `.${match[1]!.toLowerCase()}` : '';
}

export class StorageKeys {
  constructor(private readonly prefix: string) {}

  /** Every object of one file starts with this, so permanent delete is one prefix. */
  file(workspaceId: string, fileId: string): string {
    return `${this.prefix}/${safeId('workspace id', workspaceId)}/${safeId('file id', fileId)}/`;
  }

  original(workspaceId: string, fileId: string, filename: string): string {
    return `${this.file(workspaceId, fileId)}original${extensionOf(filename)}`;
  }

  derived(workspaceId: string, fileId: string, name: DerivedName): string {
    return `${this.file(workspaceId, fileId)}${name}`;
  }
}

// ── Multipart sizing ─────────────────────────────────────────────────────────────────────────

const MiB = 1024 * 1024;
/** S3's rules: parts of 5 MiB–5 GiB (the last may be smaller), at most 10,000 of them. */
export const S3_MIN_PART = 5 * MiB;
export const S3_MAX_PARTS = 10_000;

/**
 * Parts big enough to keep the count low and small enough that a dropped connection only costs
 * a few seconds: 8 MiB, growing for very large files so they stay under ~1,000 parts.
 */
export function partSizeFor(sizeBytes: number): number {
  const base = 8 * MiB;
  const forThousand = Math.ceil(sizeBytes / 1_000 / MiB) * MiB;
  return Math.max(base, forThousand);
}

export function partCountFor(sizeBytes: number, partSize: number): number {
  return Math.max(1, Math.ceil(sizeBytes / partSize));
}

// ── Client ───────────────────────────────────────────────────────────────────────────────────

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** Thrown when an object isn't there (callers turn it into a file error code). */
export class ObjectMissingError extends Error {
  constructor(readonly key: string) {
    super('Object not found in storage');
    this.name = 'ObjectMissingError';
  }
}

function clientFor(config: StorageConfig, endpoint: string | undefined): S3Client {
  const credentials =
    config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
      ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
      : undefined;
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE
      ? config.S3_FORCE_PATH_STYLE === 'true'
      : Boolean(config.S3_ENDPOINT),
    ...(credentials ? { credentials } : {}),
    // Only checksum when the operation requires it: presigned part URLs must stay plain PUTs
    // that any browser can send, and S3-compatible servers vary in checksum support.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export class Storage {
  readonly keys: StorageKeys;
  readonly bucket: string;
  private readonly s3: S3Client;
  /** Signs URLs for the host browsers use. */
  private readonly signer: S3Client;

  constructor(config: StorageConfig) {
    this.bucket = config.S3_BUCKET;
    this.keys = new StorageKeys(config.S3_PREFIX);
    this.s3 = clientFor(config, config.S3_ENDPOINT);
    this.signer = config.S3_PUBLIC_ENDPOINT
      ? clientFor(config, config.S3_PUBLIC_ENDPOINT)
      : this.s3;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const out = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!out.UploadId) throw new Error('Storage did not return an upload id');
    return out.UploadId;
  }

  /** One presigned PUT per part. The browser sends the bytes straight to storage. */
  async presignParts(
    key: string,
    uploadId: string,
    partNumbers: readonly number[],
    expiresIn = 3_600,
  ): Promise<{ partNumber: number; url: string }[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.signer,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
      })),
    );
  }

  /** The parts storage already has, so an interrupted upload resumes where it stopped. */
  async listParts(key: string, uploadId: string): Promise<(UploadedPart & { size: number })[]> {
    const parts: (UploadedPart & { size: number })[] = [];
    let marker: string | undefined;
    do {
      const out = await this.s3.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          ...(marker ? { PartNumberMarker: marker } : {}),
        }),
      );
      for (const p of out.Parts ?? []) {
        if (p.PartNumber && p.ETag)
          parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size ?? 0 });
      }
      marker = out.IsTruncated ? out.NextPartNumberMarker : undefined;
    } while (marker);
    return parts;
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly UploadedPart[]) {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
        },
      }),
    );
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.s3
      .send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }))
      .catch(() => undefined); // already completed or aborted: nothing left to clean up
  }

  /** The object's size, or ObjectMissingError. */
  async head(key: string): Promise<{ size: number; contentType?: string }> {
    try {
      const out = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: out.ContentLength ?? 0,
        ...(out.ContentType ? { contentType: out.ContentType } : {}),
      };
    } catch (error) {
      if (error instanceof NotFound || error instanceof NoSuchKey) {
        throw new ObjectMissingError(key);
      }
      throw error;
    }
  }

  /**
   * A short-lived link to read an object. `filename` makes browsers save it under the file's
   * title; `inline` lets audio and PDFs open in place (the player streams with Range requests).
   */
  async presignGet(
    key: string,
    options: { filename?: string; inline?: boolean; contentType?: string; expiresIn?: number } = {},
  ): Promise<string> {
    const disposition = options.filename
      ? `${options.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(options.filename)}`
      : undefined;
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(disposition ? { ResponseContentDisposition: disposition } : {}),
        ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
      }),
      { expiresIn: options.expiresIn ?? 900 },
    );
  }

  async getStream(key: string): Promise<Readable> {
    try {
      const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!(out.Body instanceof Readable)) throw new Error('Unexpected body type from storage');
      return out.Body;
    } catch (error) {
      if (error instanceof NoSuchKey) throw new ObjectMissingError(key);
      throw error;
    }
  }

  async getJson<T>(key: string, schema: z.ZodType<T>): Promise<T> {
    const chunks: Buffer[] = [];
    for await (const chunk of await this.getStream(key)) chunks.push(chunk as Buffer);
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(value),
        ContentType: 'application/json',
      }),
    );
  }

  async putBytes(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  /** Deletes everything under a prefix (one file's objects). Returns how many went. */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/') || prefix.split('/').length < 4) {
      // Never wider than one file: <prefix>/<workspace>/<file>/
      throw new Error('Refusing to delete a prefix wider than one file');
    }
    let deleted = 0;
    let token: string | undefined;
    do {
      const list = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      const objects = (list.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objects.length) {
        await this.s3.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects } }),
        );
        deleted += objects.length;
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }

  /** Readiness: can we reach the bucket? */
  async ping(): Promise<void> {
    await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
  }
}
