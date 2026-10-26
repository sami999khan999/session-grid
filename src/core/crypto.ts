const ITERATIONS = 600_000;
const enc = new TextEncoder();

export interface Envelope {
  format: 'sessionstack';
  v: 1;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  iv: string;
  ct: string;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(data: unknown, passphrase: string): Promise<Envelope> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data)));
  return {
    format: 'sessionstack',
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: b64(salt) },
    iv: b64(iv),
    ct: b64(new Uint8Array(ct)),
  };
}

export class DecryptError extends Error {}

export async function decryptJson<T>(envelope: unknown, passphrase: string): Promise<T> {
  const e = envelope as Envelope;
  if (e?.format !== 'sessionstack' || e.v !== 1) throw new DecryptError('Not a SessionStack export file.');
  const key = await deriveKey(passphrase, unb64(e.kdf.salt), e.kdf.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.ct));
  } catch {
    throw new DecryptError('Wrong passphrase or corrupted file.');
  }
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
