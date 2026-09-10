import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, normalizeEmail } from '@/lib/auth';

test('normalizeEmail trims and lowercases an email', () => {
  assert.equal(normalizeEmail('  Parag@Example.COM  '), 'parag@example.com');
});

test('hashPassword returns a pbkdf2 hash', async () => {
  const hash = await hashPassword('secret123');
  assert.match(hash, /^pbkdf2:sha256:\d+:([a-f0-9]{32}):[a-f0-9]+$/);
});

test('hashPassword produces different hashes for the same password', async () => {
  const a = await hashPassword('secret123');
  const b = await hashPassword('secret123');
  assert.notEqual(a, b);
});

test('verifyPassword accepts the correct password', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword(hash, 'correct-horse-battery-staple'), true);
});

test('verifyPassword rejects a wrong password', async () => {
  const hash = await hashPassword('correct-horse-battery-staple');
  assert.equal(await verifyPassword(hash, 'wrong-password'), false);
});

test('verifyPassword rejects a malformed stored hash', async () => {
  assert.equal(await verifyPassword('not-a-valid-hash', 'anything'), false);
});

test('verifyPassword returns false for an empty stored hash', async () => {
  assert.equal(await verifyPassword('', 'anything'), false);
});
