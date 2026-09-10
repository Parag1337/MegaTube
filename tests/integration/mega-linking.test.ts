/**
 * REAL-MEGA integration tests: account linking, session persistence, and
 * password-less resume.
 *
 * Environment-gated: these run ONLY when MEGA_TEST_EMAIL and
 * MEGA_TEST_PASSWORD are set. They perform real network calls against the
 * live MEGA API (login, authenticated requests, session revocation).
 *
 * No credentials, session ids, master keys, or RSA material are printed -
 * assertions check shapes/lengths, and failure messages are redacted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MegaError } from '@/lib/mega/account';

const EMAIL = process.env.MEGA_TEST_EMAIL ?? '';
const PASSWORD = process.env.MEGA_TEST_PASSWORD ?? '';
const SKIP_REASON =
  !EMAIL || !PASSWORD
    ? 'MEGA_TEST_EMAIL/MEGA_TEST_PASSWORD not set - real-MEGA linking test skipped'
    : false;

test('real MEGA: login returns valid reusable session material', { skip: SKIP_REASON }, async () => {
  const { loginToMega, validateSessionMaterial } = await import('@/lib/mega/account');

  const material = await loginToMega(EMAIL, PASSWORD);

  assert.equal(validateSessionMaterial(material), true);
  assert.ok(material.sid.length >= 50, 'sid must be a full base64url session id');
  assert.equal(Buffer.from(material.masterKey, 'base64url').length, 16, 'master key must be 16 bytes');
  assert.match(material.user, /^U/, 'MEGA user id starts with U');
  assert.equal(material.email, EMAIL.toLowerCase());

  // The password must never end up in the persisted material.
  assert.ok(!JSON.stringify(material).includes(PASSWORD), 'password leaked into session material');
});

test('real MEGA: session resumes WITHOUT a password and fetches nodes', { skip: SKIP_REASON }, async () => {
  const {
    loginToMega,
    openMegaSession,
    closeMegaSession,
    fetchAccountFileNodes,
  } = await import('@/lib/mega/account');

  const material = await loginToMega(EMAIL, PASSWORD);
  // Simulate a server restart: only the stored (encrypted-at-rest) material
  // is available - no password in scope.
  const storage = await openMegaSession(material);
  try {
    assert.equal(storage.user, material.user);
    const nodes = await fetchAccountFileNodes(storage);
    assert.ok(Array.isArray(nodes));
    for (const n of nodes) {
      assert.match(n.h, /^[A-Za-z0-9]{8,}$/, 'every decoded node has a handle');
      assert.equal(n.t, 0, 'only files are returned');
    }
  } finally {
    closeMegaSession(storage);
  }
});

test('real MEGA: closing the transport does NOT kill the stored session', { skip: SKIP_REASON }, async () => {
  const {
    loginToMega,
    openMegaSession,
    closeMegaSession,
    fetchAccountFileNodes,
  } = await import('@/lib/mega/account');

  const material = await loginToMega(EMAIL, PASSWORD);

  // First resume + close (as the session cache does on TTL eviction).
  const first = await openMegaSession(material);
  const firstCount = (await fetchAccountFileNodes(first)).length;
  closeMegaSession(first);

  // Second resume from the SAME stored material must still work.
  const second = await openMegaSession(material);
  try {
    const secondCount = (await fetchAccountFileNodes(second)).length;
    assert.equal(secondCount, firstCount, 'session must survive a transport close');
  } finally {
    closeMegaSession(second);
  }
});

test('real MEGA: sml revokes the session, resume then fails as session-expired', { skip: SKIP_REASON }, async () => {
  const {
    loginToMega,
    openMegaSession,
    logoutMegaSession,
    MegaError: MegaErrorCtor,
  } = await import('@/lib/mega/account');

  const material = await loginToMega(EMAIL, PASSWORD);
  const storage = await openMegaSession(material);
  await logoutMegaSession(storage); // sends a=sml -> kills the session server-side

  let caught: unknown = null;
  try {
    await openMegaSession(material);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MegaErrorCtor, 'resume after sml must throw MegaError');
  assert.equal((caught as MegaError).kind, 'session-expired');
});
