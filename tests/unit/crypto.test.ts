import { describe, expect, it } from 'vitest';
import { DecryptError, decryptJson, encryptJson } from '../../src/core/crypto';

describe('crypto', () => {
  it('round-trips and rejects a wrong passphrase', async () => {
    const env = await encryptJson({ hello: 'world' }, 'correct horse');
    expect(env.ct).not.toContain('world');
    expect(await decryptJson(env, 'correct horse')).toEqual({ hello: 'world' });
    await expect(decryptJson(env, 'wrong horse')).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects tampered ciphertext and foreign files', async () => {
    const env = await encryptJson([1, 2, 3], 'passphrase');
    const bytes = atob(env.ct);
    const flipped = btoa(String.fromCharCode(bytes.charCodeAt(0) ^ 1) + bytes.slice(1));
    await expect(decryptJson({ ...env, ct: flipped }, 'passphrase')).rejects.toThrow('Wrong passphrase');
    await expect(decryptJson({ some: 'json' }, 'passphrase')).rejects.toThrow('Not a SessionStack');
  });
});
