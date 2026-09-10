/**
 * Phase 2 tests: explicit user-driven MEGA reconnection.
 *
 * The MEGA network boundary (login / session resume) is injected as fakes -
 * these tests NEVER touch the real MEGA API and never perform real password
 * logins. The database is a fresh temporary SQLite file per run.
 *
 * Covered (mapped to the Phase 2 test list):
 *   1.  successful reconnect
 *   2.  failed MEGA authentication
 *   3.  REAUTH_REQUIRED -> CONNECTED
 *   4.  failed reconnect remains REAUTH_REQUIRED
 *   5.  password is not persisted
 *   6.  session material is encrypted
 *   7.  encryptedSession is never returned through public account data
 *   8.  only the owning website user can reconnect an account
 *   9.  reconnecting account #1 does not modify account #2
 *   10. CONNECTED is not claimed before session persistence succeeds
 *   11. scheduler/sync never use password authentication (source guard +
 *       REAUTH_REQUIRED never enqueued)
 *   12. sync path consumes the stored (encrypted) session, not a password
 *   13. existing REAUTH_REQUIRED behavior remains correct (sync endpoints
 *       keep rejecting; MFA + wrong-status + identity-mismatch branches)
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('mega-reconnect-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

const SECRET_PASSWORD = 'correct-horse-battery-staple-42';

let prisma: typeof import('@/lib/db')['prisma'];
let accounts: typeof import('@/lib/megaAccounts');
let reconnect: typeof import('@/lib/mega/reconnect');
let validateSessionMaterial: typeof import('@/lib/mega/account')['validateSessionMaterial'];
let tryDecryptSecretJson: typeof import('@/lib/mega/envelope')['tryDecryptSecretJson'];
let enqueueSync: typeof import('@/lib/sync/queue')['enqueueSync'];
let waitForIdle: typeof import('@/lib/sync/queue')['waitForIdle'];

const SID = Buffer.alloc(43, 7).toString('base64url');
const MASTER = Buffer.alloc(16, 1).toString('base64url');

function makeMaterial(email: string, user: string) {
  return {
    v: 1 as const,
    sid: SID,
    masterKey: MASTER,
    rsa: null,
    user,
    name: 'Test',
    email,
  };
}

/** Deps for a successful reconnect: fake login + fake resume check. */
function happyDeps(order: string[] = []) {
  return {
    login: async (email: string, password: string, mfaCode?: string) => {
      order.push(`login:${email}:${password}:${mfaCode ?? ''}`);
      return makeMaterial(email, 'Ureconn');
    },
    verify: async (material: { user: string }) => {
      order.push(`verify:${material.user}`);
      return { ok: true as const, storage: { api: { close() {} } } as never };
    },
    persist: async (id: number, userId: string, material: unknown) => {
      order.push(`persist:${id}`);
      return accounts.replaceMegaAccountSession(id, userId, material as never);
    },
    markConnected: async (id: number, userId: string) => {
      order.push(`connected:${id}`);
      return accounts.markAccountConnected(id, userId);
    },
  };
}

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  accounts = await import('@/lib/megaAccounts');
  reconnect = await import('@/lib/mega/reconnect');
  ({ validateSessionMaterial } = await import('@/lib/mega/account'));
  ({ tryDecryptSecretJson } = await import('@/lib/mega/envelope'));
  ({ enqueueSync, waitForIdle } = await import('@/lib/sync/queue'));
});

after(async () => {
  await waitForIdle(30_000);
  db.close();
});

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `reconn-${suffix}@example.com`,
      passwordHash:
        'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
    },
  });
}

async function makeReauthAccount(userId: string, label: string, email: string, megaUser: string) {
  const acc = await accounts.createMegaAccount({
    userId,
    label,
    email,
    material: makeMaterial(email, megaUser),
  });
  await accounts.markAccountReauthRequired(acc.id, 'MEGA session expired or was revoked.');
  return prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
}

// ---------------------------------------------------------------------------
// 1 + 3: successful reconnect flips REAUTH_REQUIRED -> CONNECTED
// ---------------------------------------------------------------------------

test('successful reconnect: REAUTH_REQUIRED -> CONNECTED', async () => {
  const u = await makeUser('ok');
  const acc = await makeReauthAccount(u.id, 'Main', 'reconn-ok@example.com', 'Ureconn');
  assert.equal(acc.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);

  const order: string[] = [];
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, happyDeps(order));
  assert.deepEqual(outcome, { ok: true });

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED, '3. REAUTH_REQUIRED -> CONNECTED');
  assert.equal(row.lastSyncError, null, 'previous auth errors are cleared');
  assert.ok(row.lastAuthenticatedAt, 'lastAuthenticatedAt is set');
  assert.equal(row.megaUserId, 'Ureconn', 'identity refreshed from the login');

  // Strict order: login -> verify -> persist -> CONNECTED.
  assert.deepEqual(
    order.map((s) => s.split(':')[0]),
    ['login', 'verify', 'persist', 'connected'],
    'CONNECTED only after persistence',
  );
});

test('reconnect passes the account-fixed email (never user input) and MFA code to login', async () => {
  const u = await makeUser('mfa-pass');
  const acc = await makeReauthAccount(u.id, 'MFA', 'reconn-mfa-pass@example.com', 'Ureconn');
  const order: string[] = [];
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, '123456', happyDeps(order));
  assert.deepEqual(outcome, { ok: true });
  assert.equal(order[0], `login:reconn-mfa-pass@example.com:${SECRET_PASSWORD}:123456`);
});

// ---------------------------------------------------------------------------
// 2 + 4: failed authentication keeps REAUTH_REQUIRED
// ---------------------------------------------------------------------------

test('failed MEGA authentication: account remains REAUTH_REQUIRED, material untouched', async () => {
  const u = await makeUser('authfail');
  const acc = await makeReauthAccount(u.id, 'AF', 'reconn-authfail@example.com', 'Uaf');
  const before = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });

  const outcome = await reconnect.reconnectMegaAccount(
    acc.id,
    u.id,
    'wrong-password',
    undefined,
    {
      ...happyDeps(),
      login: async () => {
        throw new (await import('@/lib/mega/account')).MegaError('auth', 'MEGA rejected the credentials.');
      },
    },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok ? '' : outcome.reason, 'auth-failed');
  assert.ok(!outcome.ok ? !/wrong-password/.test(outcome.message) : false, 'error never echoes the password');

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED, '4. failed reconnect stays REAUTH_REQUIRED');
  assert.equal(row.encryptedSession, before.encryptedSession, 'stored material untouched on failure');
});

test('MFA-required login surfaces the MFA reason and stays REAUTH_REQUIRED', async () => {
  const u = await makeUser('mfafail');
  const acc = await makeReauthAccount(u.id, 'MFAF', 'reconn-mfafail@example.com', 'Umfaf');
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, {
    ...happyDeps(),
    login: async () => {
      throw new (await import('@/lib/mega/account')).MegaError('mfa', '2FA required.');
    },
  });
  assert.equal(outcome.ok ? '' : outcome.reason, 'mfa');
  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
});

test('transient MEGA failure maps to transient (retryable) reason', async () => {
  const u = await makeUser('trans');
  const acc = await makeReauthAccount(u.id, 'T', 'reconn-trans@example.com', 'Utrans');
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, {
    ...happyDeps(),
    login: async () => {
      throw new (await import('@/lib/mega/account')).MegaError('transient', 'MEGA is temporarily unavailable.');
    },
  });
  assert.equal(outcome.ok ? '' : outcome.reason, 'transient');
});

// ---------------------------------------------------------------------------
// 5 + 6: password never persisted; material stored encrypted
// ---------------------------------------------------------------------------

test('password is not persisted anywhere in the database row', async () => {
  const u = await makeUser('nopw');
  const acc = await makeReauthAccount(u.id, 'NP', 'reconn-nopw@example.com', 'Unopw');
  await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, happyDeps());

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  const rowJson = JSON.stringify(row);
  assert.ok(!rowJson.includes(SECRET_PASSWORD), '5. password must never appear in the DB row');
  // The decrypted session material must not contain it either.
  const material = tryDecryptSecretJson(row.encryptedSession) as Record<string, unknown> | null;
  assert.ok(material);
  assert.ok(!JSON.stringify(material).includes(SECRET_PASSWORD), 'password not inside session material');
  assert.equal(material!.password, undefined);
  assert.equal(Object.keys(material!).sort().join(','), 'email,masterKey,name,rsa,sid,user,v', 'material has no unexpected fields');
});

test('session material is stored encrypted (v1 envelope, no plaintext secrets)', async () => {
  const u = await makeUser('enc');
  const acc = await makeReauthAccount(u.id, 'EN', 'reconn-enc@example.com', 'Uenc');
  await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, happyDeps());

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.ok(row.encryptedSession.startsWith('v1.'), '6. AES-256-GCM envelope format preserved');
  assert.ok(!row.encryptedSession.includes(SID), 'raw sid must not appear in the blob');
  assert.ok(!row.encryptedSession.includes(MASTER), 'raw master key must not appear in the blob');

  // And it decrypts back to valid session material with the env key.
  const material = tryDecryptSecretJson(row.encryptedSession);
  assert.equal(validateSessionMaterial(material), true);
});

// ---------------------------------------------------------------------------
// 7: encryptedSession never leaves the server through public data
// ---------------------------------------------------------------------------

test('public account data never includes encryptedSession', async () => {
  const u = await makeUser('pub');
  const acc = await makeReauthAccount(u.id, 'PU', 'reconn-pub@example.com', 'Upub');
  await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, happyDeps());

  const listed = await accounts.listMegaAccountsForUser(u.id);
  assert.ok(listed.length >= 1);
  const json = JSON.stringify(listed);
  assert.ok(!json.includes('encryptedSession'), '7. encryptedSession key absent from public account data');
  assert.ok(!json.includes(SID), 'sid must not leak through public account data');
  assert.ok(!json.includes(MASTER), 'master key must not leak through public account data');

  // The reconnect outcome itself carries no material either.
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, happyDeps());
  assert.ok(!JSON.stringify(outcome).includes(SID));
});

// ---------------------------------------------------------------------------
// 8: only the owning website user can reconnect (IDOR)
// ---------------------------------------------------------------------------

test("another user's reconnect attempt is rejected and changes nothing", async () => {
  const a = await makeUser('owner');
  const b = await makeUser('intruder');
  const acc = await makeReauthAccount(a.id, 'Own', 'reconn-owner@example.com', 'Uown');
  const before = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });

  const outcome = await reconnect.reconnectMegaAccount(acc.id, b.id, SECRET_PASSWORD, undefined, happyDeps());
  assert.equal(outcome.ok ? '' : outcome.reason, 'not-found', '8. foreign account is indistinguishable from missing');
  assert.equal(outcome.ok ? '' : outcome.message, 'Account not found.');

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
  assert.equal(row.encryptedSession, before.encryptedSession);
  assert.equal(row.lastAuthenticatedAt === null, before.lastAuthenticatedAt === null);
});

// ---------------------------------------------------------------------------
// 9: multiple accounts - reconnecting #1 never touches #2
// ---------------------------------------------------------------------------

test('reconnecting account #1 does not modify account #2 (same user)', async () => {
  const u = await makeUser('multi');
  const acc1 = await makeReauthAccount(u.id, 'One', 'reconn-multi1@example.com', 'Ureconn');
  const acc2 = await makeReauthAccount(u.id, 'Two', 'reconn-multi2@example.com', 'Ureconn2');
  const before2 = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc2.id } });

  const outcome = await reconnect.reconnectMegaAccount(acc1.id, u.id, SECRET_PASSWORD, undefined, happyDeps());
  assert.deepEqual(outcome, { ok: true });

  const after1 = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc1.id } });
  const after2 = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc2.id } });

  assert.equal(after1.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);
  assert.equal(after2.status, before2.status, '9. account #2 status unchanged');
  assert.equal(after2.encryptedSession, before2.encryptedSession, '9. account #2 session material unchanged');
  assert.equal(after2.megaUserId, before2.megaUserId, '9. account #2 identity unchanged');
  assert.equal(after2.lastAuthenticatedAt?.getTime() ?? null, before2.lastAuthenticatedAt?.getTime() ?? null);
});

// ---------------------------------------------------------------------------
// 10: CONNECTED not claimed before persistence succeeds
// ---------------------------------------------------------------------------

test('persistence failure: markConnected never runs, account stays REAUTH_REQUIRED', async () => {
  const u = await makeUser('persistfail');
  const acc = await makeReauthAccount(u.id, 'PF', 'reconn-persistfail@example.com', 'Ureconn');
  const before = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });

  const order: string[] = [];
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, {
    ...happyDeps(order),
    persist: async () => {
      order.push('persist:FAIL');
      throw new Error('db write failed');
    },
  });

  assert.equal(outcome.ok ? '' : outcome.reason, 'persist-failed');
  assert.equal(outcome.ok ? '' : outcome.message, 'The MEGA session could not be saved. Please try reconnecting again.');
  assert.equal(order.length, 3, '10. no CONNECTED write after failed persistence');
  assert.ok(order[0].startsWith('login:'));
  assert.ok(order[1].startsWith('verify:'));
  assert.equal(order[2], 'persist:FAIL');

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED, '10. still REAUTH_REQUIRED');
  assert.equal(row.encryptedSession, before.encryptedSession, 'old material preserved');
});

test('session-resume verification failure: no persistence, stays REAUTH_REQUIRED', async () => {
  const u = await makeUser('verifyfail');
  const acc = await makeReauthAccount(u.id, 'VF', 'reconn-verifyfail@example.com', 'Ureconn');
  const before = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });

  const order: string[] = [];
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, {
    ...happyDeps(order),
    verify: async () => {
      order.push('verify:FAIL');
      return { ok: false as const, kind: 'session-expired' as const };
    },
  });

  assert.equal(outcome.ok ? '' : outcome.reason, 'session-verify-failed');
  assert.equal(order.length, 2, 'no persist/CONNECTED after failed verification');
  assert.ok(order[0].startsWith('login:'), 'login ran first');
  assert.equal(order[1], 'verify:FAIL');

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
  assert.equal(row.encryptedSession, before.encryptedSession);
});

// ---------------------------------------------------------------------------
// Guard rails: status gate + missing password
// ---------------------------------------------------------------------------

test('reconnect is rejected for accounts not in REAUTH_REQUIRED', async () => {
  const u = await makeUser('wrongstatus');
  const acc = await accounts.createMegaAccount({
    userId: u.id,
    label: 'WS',
    email: 'reconn-wrongstatus@example.com',
    material: makeMaterial('reconn-wrongstatus@example.com', 'Uws'),
  });
  assert.equal(acc.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);

  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, happyDeps());
  assert.equal(outcome.ok ? '' : outcome.reason, 'wrong-status');
  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);
});

test('reconnect without a password is rejected before any MEGA contact', async () => {
  const u = await makeUser('nopass');
  const acc = await makeReauthAccount(u.id, 'NOP', 'reconn-nopass@example.com', 'Unop');
  let loginCalled = false;
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, '', undefined, {
    ...happyDeps(),
    login: async () => {
      loginCalled = true;
      return makeMaterial('x@y.z', 'Ux');
    },
  });
  assert.equal(outcome.ok ? '' : outcome.reason, 'missing-password');
  assert.equal(loginCalled, false, 'login must not run without a password');
});

test('identity mismatch: login returning a different MEGA user is rejected', async () => {
  const u = await makeUser('ident');
  const acc = await makeReauthAccount(u.id, 'ID', 'reconn-ident@example.com', 'Uident');
  const outcome = await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, {
    ...happyDeps(),
    login: async (email: string) => makeMaterial(email, 'Uother'),
  });
  assert.equal(outcome.ok ? '' : outcome.reason, 'identity-mismatch');
  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
});

// ---------------------------------------------------------------------------
// 11 + 12 + 13: scheduler/sync never use passwords; stored-session path intact
// ---------------------------------------------------------------------------

test('no module under lib/sync references password login or the reconnect flow', async () => {
  const syncDir = path.resolve(process.cwd(), 'lib/sync');
  const files = fs.readdirSync(syncDir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const src = fs.readFileSync(path.join(syncDir, f), 'utf8');
    assert.ok(!/loginToMega/.test(src), `11. lib/sync/${f} must never call loginToMega (password auth)`);
    assert.ok(!/reconnectMegaAccount/.test(src), `11. lib/sync/${f} must never trigger reconnection`);
  }
});

test('after reconnect the sync path can resume from the stored session alone', async () => {
  const u = await makeUser('resume');
  const acc = await makeReauthAccount(u.id, 'RS', 'reconn-resume@example.com', 'Ureconn');
  await reconnect.reconnectMegaAccount(acc.id, u.id, SECRET_PASSWORD, undefined, happyDeps());

  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  // Exactly what withMegaSession (the sync/playback path) consumes: decrypt
  // with MEGA_SESSION_ENCRYPTION_KEY -> validate -> openMegaSession. No
  // password is involved anywhere in that chain. (CONNECTED accounts pass
  // the queue gate - see sync-queue.test.ts 'CONNECTED account can be
  // enqueued' - so Sync Now becomes available after reconnect.)
  const material = tryDecryptSecretJson(row.encryptedSession);
  assert.equal(validateSessionMaterial(material), true, '12. stored blob is resumable session material');
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED, 'Sync Now gate passes for CONNECTED');

  // REAUTH_REQUIRED accounts are still rejected before any job runs (13).
  const acc2 = await makeReauthAccount(u.id, 'RS2', 'reconn-resume2@example.com', 'Uresume2');
  assert.equal(await enqueueSync(acc2.id, 'manual'), 'not-eligible', '13. REAUTH_REQUIRED still not enqueueable');
  assert.equal(await enqueueSync(acc2.id, 'schedule'), 'not-eligible', '13. scheduler source still rejected');
});

test('markAccountConnected is ownership-scoped', async () => {
  const a = await makeUser('conn-owner');
  const b = await makeUser('conn-other');
  const acc = await makeReauthAccount(a.id, 'CO', 'reconn-conn-owner@example.com', 'Uco');

  await assert.rejects(() => accounts.markAccountConnected(acc.id, b.id), /not-found/);
  const row = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(row.status, accounts.MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);

  await accounts.markAccountConnected(acc.id, a.id);
  const ok = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(ok.status, accounts.MEGA_ACCOUNT_STATUSES.CONNECTED);
});
