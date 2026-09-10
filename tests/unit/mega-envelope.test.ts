import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

import {
  encryptSecret,
  decryptSecret,
  tryDecryptSecretJson,
  getEnvelopeKey,
  hasEnvelopeKey,
  MegaConfigError,
} from '@/lib/mega/envelope';

const KEY_A = 'ab'.repeat(32);
const KEY_B = 'cd'.repeat(32);

function toB64Url(raw: Buffer): string {
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

test('round trip: JSON string', () => {
  const msg = JSON.stringify({ sid: 'abc', masterKey: 'xyz' });
  const blob = encryptSecret(msg);
  assert.ok(blob.startsWith('v1.'));
  assert.equal(decryptSecret(blob).toString('utf8'), msg);
});

test('round trip: raw Buffer', () => {
  const data = crypto.randomBytes(32);
  const blob = encryptSecret(data);
  assert.ok(decryptSecret(blob).equals(data));
});

test('random IV: two encryptions of the same plaintext differ', () => {
  const a = encryptSecret('same-secret');
  const b = encryptSecret('same-secret');
  assert.notEqual(a, b);
  // both still decrypt to the same value
  assert.equal(decryptSecret(a).toString('utf8'), decryptSecret(b).toString('utf8'));
});

test('payload uses base64url charset only', () => {
  const payload = encryptSecret('hello').slice(3);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
});

test('tampered ciphertext is rejected', () => {
  const blob = encryptSecret('top secret');
  const raw = fromB64Url(blob.slice(3));
  const idx = 12 + Math.floor((raw.length - 28) / 2); // inside ciphertext
  raw[idx] ^= 0xff;
  const tampered = 'v1.' + toB64Url(raw);
  assert.throws(() => decryptSecret(tampered));
});

test('tampered auth tag is rejected', () => {
  const blob = encryptSecret('top secret');
  const raw = fromB64Url(blob.slice(3));
  raw[raw.length - 5] ^= 0xff; // inside the 16-byte tag zone
  const tampered = 'v1.' + toB64Url(raw);
  assert.throws(() => decryptSecret(tampered));
});

test('malformed envelopes are rejected', () => {
  assert.throws(() => decryptSecret(''));
  assert.throws(() => decryptSecret('v2.abcdef'));
  assert.throws(() => decryptSecret('garbage'));
  assert.throws(() => decryptSecret('v1.abc'));
});

test('wrong key cannot decrypt', () => {
  const saved = process.env.MEGA_SESSION_ENCRYPTION_KEY;
  try {
    process.env.MEGA_SESSION_ENCRYPTION_KEY = KEY_A;
    const blob = encryptSecret('bank-account');
    process.env.MEGA_SESSION_ENCRYPTION_KEY = KEY_B;
    assert.throws(() => decryptSecret(blob));
    process.env.MEGA_SESSION_ENCRYPTION_KEY = KEY_A;
    assert.equal(decryptSecret(blob).toString('utf8'), 'bank-account');
  } finally {
    process.env.MEGA_SESSION_ENCRYPTION_KEY = saved;
  }
});

test('tryDecryptSecretJson returns null for nullish/invalid input', () => {
  assert.equal(tryDecryptSecretJson(null), null);
  assert.equal(tryDecryptSecretJson(undefined), null);
  assert.equal(tryDecryptSecretJson(''), null);
  assert.equal(tryDecryptSecretJson('not-an-envelope'), null);
  const blob = encryptSecret(JSON.stringify({ ok: 1 }));
  assert.deepEqual(tryDecryptSecretJson(blob), { ok: 1 });
});

test('getEnvelopeKey rejects missing/invalid env values', () => {
  const saved = process.env.MEGA_SESSION_ENCRYPTION_KEY;
  try {
    process.env.MEGA_SESSION_ENCRYPTION_KEY = '';
    assert.throws(() => getEnvelopeKey(), MegaConfigError);

    process.env.MEGA_SESSION_ENCRYPTION_KEY = 'nothex';
    assert.throws(() => getEnvelopeKey(), MegaConfigError);

    // 64 chars but contains a non-hex character
    process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(31) + 'gg';
    assert.throws(() => getEnvelopeKey(), MegaConfigError);

    // 63 chars (too short)
    process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(31) + 'g';
    assert.throws(() => getEnvelopeKey(), MegaConfigError);

    process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);
    assert.equal(getEnvelopeKey().length, 32);
  } finally {
    process.env.MEGA_SESSION_ENCRYPTION_KEY = saved;
  }
});

test('hasEnvelopeKey reflects env state', () => {
  const saved = process.env.MEGA_SESSION_ENCRYPTION_KEY;
  try {
    process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);
    assert.equal(hasEnvelopeKey(), true);
    process.env.MEGA_SESSION_ENCRYPTION_KEY = 'short';
    assert.equal(hasEnvelopeKey(), false);
    delete process.env.MEGA_SESSION_ENCRYPTION_KEY;
    assert.equal(hasEnvelopeKey(), false);
  } finally {
    process.env.MEGA_SESSION_ENCRYPTION_KEY = saved;
  }
});
