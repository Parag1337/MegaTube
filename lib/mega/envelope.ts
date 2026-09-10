/**
 * Envelope encryption for MEGA secrets at rest.
 *
 * Protects two kinds of material:
 *   1. Per-account MEGA session material (sid + master key + RSA private key)
 *   2. Per-video MEGA file keys
 *
 * Scheme: AES-256-GCM with a random 12-byte IV per record.
 * Storage format: "v1." + base64url(iv(12) || ciphertext || authTag(16))
 *
 * The envelope key comes from the environment (never committed):
 *   MEGA_SESSION_ENCRYPTION_KEY = 64 hex characters (32 bytes)
 *
 * Generate one with: npm run keygen
 *
 * Security properties:
 *   - GCM authentication: any tampering with the stored blob is detected on
 *     decrypt (auth tag mismatch) instead of silently yielding garbage.
 *   - Random IV per record: identical material never produces identical
 *     ciphertext.
 *   - The envelope key is never written to the database, logs, or responses.
 */

import crypto from 'node:crypto';

const FORMAT_VERSION = 'v1.';
const KEY_ENV_VAR = 'MEGA_SESSION_ENCRYPTION_KEY';

export class MegaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MegaConfigError';
  }
}

export function getEnvelopeKey(): Buffer {
  const raw = process.env[KEY_ENV_VAR] ?? '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) {
    throw new MegaConfigError(
      `Server is not configured for MEGA linking: set ${KEY_ENV_VAR} to a 64-character hex key (npm run keygen).`,
    );
  }
  return Buffer.from(raw, 'hex');
}

export function hasEnvelopeKey(): boolean {
  return /^[a-f0-9]{64}$/i.test(process.env[KEY_ENV_VAR] ?? '');
}

function b64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlDecode(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** Encrypt a secret (JSON string or bytes) with the envelope key. */
export function encryptSecret(plaintext: string | Buffer): string {
  const key = getEnvelopeKey();
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return FORMAT_VERSION + b64Url(Buffer.concat([iv, ciphertext, tag]));
}

/** Decrypt a blob produced by {@link encryptSecret}. Throws on tamper or bad key. */
export function decryptSecret(stored: string): Buffer {
  if (typeof stored !== 'string' || !stored.startsWith(FORMAT_VERSION)) {
    throw new Error('Invalid secret blob format');
  }
  const key = getEnvelopeKey();
  const raw = b64UrlDecode(stored.slice(FORMAT_VERSION.length));
  if (raw.length < 12 + 16) {
    throw new Error('Invalid secret blob length');
  }
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(12, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Decrypt a JSON document. Returns null instead of throwing for missing/invalid blobs. */
export function tryDecryptSecretJson(stored: string | null | undefined): unknown | null {
  if (!stored) return null;
  try {
    return JSON.parse(decryptSecret(stored).toString('utf8'));
  } catch {
    return null;
  }
}
