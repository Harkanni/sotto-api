/**
 * Envelope encryption for workspace API keys (BRIEF §3: "BYOK keys are envelope-encrypted at
 * rest — AWS KMS in prod, a local master key in dev").
 *
 * Each key gets its own random 256-bit data key (DEK). The DEK encrypts the API key with
 * AES-256-GCM; a `KeyWrapper` (the master key) encrypts the DEK. The database stores the
 * ciphertext, the wrapped DEK and which wrapper wrapped it, never the DEK or the key itself.
 * Rotating the master key means re-wrapping DEKs, not re-encrypting every key, and a KMS
 * wrapper keeps the master key out of the api's memory entirely.
 *
 * The workspace id is bound in as additional authenticated data, so a ciphertext copied into
 * another workspace's row fails to decrypt instead of handing that workspace someone's key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Wraps and unwraps data keys. Local in development and the demo; KMS in production. */
export interface KeyWrapper {
  /** Stored beside each key ("local:3fa1c2d4", "kms:arn:aws:kms:…"), so the right one unwraps it. */
  readonly id: string;
  wrap(dek: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

/** What the database stores for one key. */
export interface SealedKey {
  encryptedKey: Buffer;
  wrappedDek: Buffer;
  keyWrapper: string;
  /** The last four characters, the only part the UI ever shows. */
  keyLast4: string;
}

export class VaultError extends Error {
  constructor(
    readonly code: 'no_master_key' | 'unknown_wrapper' | 'decrypt_failed' | 'bad_master_key',
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function gcmDecrypt(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('too short');
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/**
 * A master key held in config (`AI_KEYS_MASTER`, 32 random bytes in base64). Its id is a short
 * hash of the key, so a rotated key is told apart without storing anything secret.
 */
export class LocalKeyWrapper implements KeyWrapper {
  readonly id: string;
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    const key = Buffer.from(masterKeyBase64.trim(), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new VaultError(
        'bad_master_key',
        `The master key must be ${KEY_BYTES} bytes in base64 (openssl rand -base64 32).`,
      );
    }
    this.key = key;
    this.id = `local:${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
  }

  wrap(dek: Buffer): Promise<Buffer> {
    return Promise.resolve(gcmEncrypt(this.key, dek, Buffer.from(this.id)));
  }

  unwrap(wrapped: Buffer): Promise<Buffer> {
    return Promise.resolve(gcmDecrypt(this.key, wrapped, Buffer.from(this.id)));
  }
}

/**
 * Seals and opens API keys. The first wrapper wraps new keys; the others only unwrap (old master
 * keys during a rotation). With no wrapper the vault refuses to store keys rather than storing
 * them weakly.
 */
export class KeyVault {
  constructor(private readonly wrappers: readonly KeyWrapper[]) {}

  /** False when the server has no master key: BYOK keys can't be saved, and the UI says so. */
  get available(): boolean {
    return this.wrappers.length > 0;
  }

  async seal(secret: string, workspaceId: string): Promise<SealedKey> {
    const wrapper = this.wrappers[0];
    if (!wrapper) throw new VaultError('no_master_key', 'No master key is configured.');
    const dek = randomBytes(KEY_BYTES);
    try {
      const value = secret.trim();
      return {
        encryptedKey: gcmEncrypt(dek, Buffer.from(value, 'utf8'), Buffer.from(workspaceId)),
        wrappedDek: await wrapper.wrap(dek),
        keyWrapper: wrapper.id,
        keyLast4: value.slice(-4),
      };
    } finally {
      dek.fill(0);
    }
  }

  async open(
    sealed: { encryptedKey: Uint8Array; wrappedDek: Uint8Array; keyWrapper: string },
    workspaceId: string,
  ): Promise<string> {
    const wrapper = this.wrappers.find((w) => w.id === sealed.keyWrapper);
    if (!wrapper) {
      throw new VaultError('unknown_wrapper', `No master key ${sealed.keyWrapper} is configured.`);
    }
    let dek: Buffer | null = null;
    try {
      dek = await wrapper.unwrap(Buffer.from(sealed.wrappedDek));
      const plain = gcmDecrypt(dek, Buffer.from(sealed.encryptedKey), Buffer.from(workspaceId));
      return plain.toString('utf8');
    } catch (error) {
      if (error instanceof VaultError) throw error;
      // Never include the cause: it could carry key material in some runtimes' messages.
      throw new VaultError('decrypt_failed', 'The stored key could not be decrypted.');
    } finally {
      dek?.fill(0);
    }
  }

  /** Re-wraps a key's data key with the current master key (rotation), keeping its ciphertext. */
  async rewrap(sealed: { wrappedDek: Uint8Array; keyWrapper: string }): Promise<{
    wrappedDek: Buffer;
    keyWrapper: string;
  }> {
    const current = this.wrappers[0];
    const old = this.wrappers.find((w) => w.id === sealed.keyWrapper);
    if (!current) throw new VaultError('no_master_key', 'No master key is configured.');
    if (!old) {
      throw new VaultError('unknown_wrapper', `No master key ${sealed.keyWrapper} is configured.`);
    }
    const dek = await old.unwrap(Buffer.from(sealed.wrappedDek));
    try {
      return { wrappedDek: await current.wrap(dek), keyWrapper: current.id };
    } finally {
      dek.fill(0);
    }
  }
}

/**
 * The vault from settings: `AI_KEYS_MASTER` wraps new keys; `AI_KEYS_MASTER_PREVIOUS` (comma
 * separated) still opens keys wrapped before a rotation. A KMS wrapper joins here in Phase 11.
 */
export function keyVaultFrom(settings: {
  AI_KEYS_MASTER?: string | undefined;
  AI_KEYS_MASTER_PREVIOUS?: string | undefined;
}): KeyVault {
  const wrappers: KeyWrapper[] = [];
  if (settings.AI_KEYS_MASTER) wrappers.push(new LocalKeyWrapper(settings.AI_KEYS_MASTER));
  for (const old of (settings.AI_KEYS_MASTER_PREVIOUS ?? '').split(',')) {
    if (old.trim()) wrappers.push(new LocalKeyWrapper(old));
  }
  return new KeyVault(wrappers);
}
