import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMegaError,
  safeMegaErrorMessage,
  validateSessionMaterial,
  MegaError,
} from '@/lib/mega/account';

const VALID_SID = 'x'.repeat(58);
const VALID_MASTER_KEY = Buffer.alloc(16, 7).toString('base64url');

function material(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    sid: VALID_SID,
    masterKey: VALID_MASTER_KEY,
    rsa: null,
    user: 'Utest123',
    name: 'Test',
    email: 't@example.com',
    ...overrides,
  };
}

test('valid session material accepted (rsa null)', () => {
  assert.equal(validateSessionMaterial(material()), true);
});

test('valid session material accepted (rsa with 4 limbs)', () => {
  assert.equal(validateSessionMaterial(material({ rsa: [[1], [2], [3], [4]] })), true);
});

test('malformed session material rejected', () => {
  assert.equal(validateSessionMaterial(null), false);
  assert.equal(validateSessionMaterial(undefined), false);
  assert.equal(validateSessionMaterial('nope'), false);
  assert.equal(validateSessionMaterial(material({ v: 2 })), false);
  assert.equal(validateSessionMaterial(material({ sid: 'short' })), false);
  assert.equal(
    validateSessionMaterial(material({ masterKey: Buffer.alloc(15).toString('base64url') })),
    false,
  );
  assert.equal(validateSessionMaterial(material({ rsa: [[1], [2], [3]] })), false);
  assert.equal(validateSessionMaterial(material({ email: 42 })), false);
  assert.equal(validateSessionMaterial(material({ user: 7 })), false);
});

test('classifyMegaError: -15 (ESID) -> session-expired in any context', () => {
  assert.equal(classifyMegaError(new Error('request failed (-15)'), 'session'), 'session-expired');
  assert.equal(classifyMegaError(new Error('request failed (-15)'), 'login'), 'session-expired');
  assert.equal(classifyMegaError('some crash text (-15) inside', 'session'), 'session-expired');
});

test('classifyMegaError: -9 login -> auth, -9 session -> unknown (not auto-retry)', () => {
  assert.equal(classifyMegaError(new Error('bad request (-9)'), 'login'), 'auth');
  assert.equal(classifyMegaError(new Error('request failed (-9)'), 'session'), 'unknown');
});

test('classifyMegaError: -26 -> mfa', () => {
  assert.equal(classifyMegaError(new Error('request failed (-26)'), 'login'), 'mfa');
  assert.equal(classifyMegaError(new Error('request failed (-26)'), 'session'), 'mfa');
});

test('classifyMegaError: transient errors', () => {
  const transientMessages = [
    'fetch failed',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'socket hang up',
    'request failed (-18)',
    'request failed (-19)',
    'server returned error',
    'database is too busy',
  ];
  for (const msg of transientMessages) {
    assert.equal(classifyMegaError(new Error(msg), 'session'), 'transient', msg);
  }
});

test('classifyMegaError: unexpected failure is permanent at login, unknown in session', () => {
  assert.equal(classifyMegaError(new Error('totally weird'), 'login'), 'auth');
  assert.equal(classifyMegaError(new Error('totally weird'), 'session'), 'unknown');
  assert.equal(classifyMegaError('plain string error (-16)', 'login'), 'auth');
});

test('MegaError carries kind, safe message, and api code', () => {
  const err = new MegaError('session-expired', safeMegaErrorMessage('session-expired'), -15);
  assert.equal(err.name, 'MegaError');
  assert.equal(err.kind, 'session-expired');
  assert.equal(err.apiCode, -15);
  assert.ok(err.message.length > 0);
  // safe message must not leak technical detail
  assert.ok(!/sid|masterkey|privk|rsa/i.test(err.message));
});

test('safeMegaErrorMessage: all kinds produce stable, human-safe text', () => {
  const kinds = ['session-expired', 'auth', 'mfa', 'transient', 'unknown'] as const;
  const messages = kinds.map((k) => safeMegaErrorMessage(k));
  for (let i = 0; i < kinds.length; i++) {
    assert.match(messages[i], /^[A-Z].*\.$/, kinds[i]);
    assert.ok(messages[i].length > 10, kinds[i]);
    assert.ok(!/[{}]/.test(messages[i]), kinds[i]);
  }
  // distinct messages for distinct kinds
  assert.equal(new Set(messages).size, messages.length);
});

test('session-expired maps to the re-auth user message', () => {
  assert.match(safeMegaErrorMessage('session-expired'), /Reconnect/i);
});
