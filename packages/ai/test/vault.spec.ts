import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyVault, LocalKeyWrapper, VaultError, keyVaultFrom } from '../src/vault.js';

const master = () => randomBytes(32).toString('base64');
const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz-1234';

describe('KeyVault', () => {
  it('seals a key so the database never holds it, and opens it again', async () => {
    const vault = keyVaultFrom({ AI_KEYS_MASTER: master() });
    const sealed = await vault.seal(SECRET, 'ws_a');
    expect(sealed.keyLast4).toBe('1234');
    expect(sealed.keyWrapper).toMatch(/^local:[0-9a-f]{8}$/);
    for (const blob of [sealed.encryptedKey, sealed.wrappedDek]) {
      expect(blob.toString('utf8')).not.toContain('sk-ant');
      expect(blob.toString('latin1')).not.toContain('abcdefghijklmnop');
    }
    await expect(vault.open(sealed, 'ws_a')).resolves.toBe(SECRET);
  });

  it('uses a fresh data key and IV every time', async () => {
    const vault = keyVaultFrom({ AI_KEYS_MASTER: master() });
    const a = await vault.seal(SECRET, 'ws_a');
    const b = await vault.seal(SECRET, 'ws_a');
    expect(a.encryptedKey.equals(b.encryptedKey)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it("won't open a key copied into another workspace", async () => {
    const vault = keyVaultFrom({ AI_KEYS_MASTER: master() });
    const sealed = await vault.seal(SECRET, 'ws_a');
    await expect(vault.open(sealed, 'ws_b')).rejects.toMatchObject({ code: 'decrypt_failed' });
  });

  it('detects tampering', async () => {
    const vault = keyVaultFrom({ AI_KEYS_MASTER: master() });
    const sealed = await vault.seal(SECRET, 'ws_a');
    const bad = Buffer.from(sealed.encryptedKey);
    bad[bad.length - 1]! ^= 1;
    await expect(vault.open({ ...sealed, encryptedKey: bad }, 'ws_a')).rejects.toBeInstanceOf(
      VaultError,
    );
  });

  it('opens keys from a previous master key and re-wraps them with the current one', async () => {
    const oldMaster = master();
    const before = keyVaultFrom({ AI_KEYS_MASTER: oldMaster });
    const sealed = await before.seal(SECRET, 'ws_a');
    const after = keyVaultFrom({ AI_KEYS_MASTER: master(), AI_KEYS_MASTER_PREVIOUS: oldMaster });
    await expect(after.open(sealed, 'ws_a')).resolves.toBe(SECRET);
    const rewrapped = await after.rewrap(sealed);
    expect(rewrapped.keyWrapper).not.toBe(sealed.keyWrapper);
    const onlyNew = new KeyVault([new LocalKeyWrapper(master())]);
    await expect(onlyNew.open({ ...sealed, ...rewrapped }, 'ws_a')).rejects.toMatchObject({
      code: 'unknown_wrapper',
    });
    await expect(after.open({ ...sealed, ...rewrapped }, 'ws_a')).resolves.toBe(SECRET);
  });

  it('refuses to store keys without a master key, and rejects a short one', async () => {
    const vault = keyVaultFrom({});
    expect(vault.available).toBe(false);
    await expect(vault.seal(SECRET, 'ws_a')).rejects.toMatchObject({ code: 'no_master_key' });
    expect(() => new LocalKeyWrapper(randomBytes(16).toString('base64'))).toThrow(VaultError);
  });
});
