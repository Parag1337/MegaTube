/**
 * Clerk -> MegaTube user mapping tests (isolated DB from repo migrations).
 *
 * The critical guarantee: an existing MegaTube user signing in through
 * Clerk for the first time is LINKED (by verified email) to its existing
 * row - never duplicated - so every MEGA account, video, watchlist entry,
 * saved video, folder, and history row stays attached to the same User.id.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('clerk-mapping-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let resolveMegaUserForClerk: typeof import('@/lib/clerkUser')['resolveMegaUserForClerk'];
let verifyPassword: typeof import('@/lib/auth')['verifyPassword'];

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  ({ resolveMegaUserForClerk } = await import('@/lib/clerkUser'));
  ({ verifyPassword } = await import('@/lib/auth'));
});

after(() => {
  db.close();
});

const PASSWORD_HASH =
  'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

test('existing user is linked by email and keeps its id', async () => {
  const existing = await prisma.user.create({
    data: { email: 'owner@example.com', passwordHash: PASSWORD_HASH },
  });
  const account = await prisma.megaAccount.create({
    data: {
      userId: existing.id,
      label: 'Acc',
      megaEmail: 'm@example.com',
      encryptedSession: 's',
      status: 'CONNECTED',
    },
  });

  const resolved = await resolveMegaUserForClerk('user_clerk_1', 'owner@example.com');

  assert.ok(resolved);
  assert.equal(resolved.id, existing.id, 'must resolve to the SAME MegaTube user id');
  assert.equal(resolved.email, 'owner@example.com');

  const row = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
  assert.equal(row.clerkUserId, 'user_clerk_1');

  // Existing user-owned data is untouched.
  const stillThere = await prisma.megaAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert.equal(stillThere.userId, existing.id);
});

test('repeat sign-in with the same Clerk id resolves the same user', async () => {
  const first = await resolveMegaUserForClerk('user_clerk_1', 'owner@example.com');
  const second = await resolveMegaUserForClerk('user_clerk_1', 'owner@example.com');
  assert.ok(first && second);
  assert.equal(first.id, second.id);
  assert.equal(await prisma.user.count(), 1);
});

test('email matching is case/whitespace insensitive', async () => {
  const resolved = await resolveMegaUserForClerk('user_clerk_1', '  Owner@Example.COM ');
  assert.ok(resolved);
  assert.equal(resolved.email, 'owner@example.com');
  assert.equal(await prisma.user.count(), 1);
});

test('email linked to a different Clerk identity is never stolen', async () => {
  const resolved = await resolveMegaUserForClerk('user_clerk_OTHER', 'owner@example.com');
  assert.equal(resolved, null);
  const row = await prisma.user.findUniqueOrThrow({ where: { email: 'owner@example.com' } });
  assert.equal(row.clerkUserId, 'user_clerk_1');
});

test('unknown email creates a new user that cannot password-login', async () => {
  const resolved = await resolveMegaUserForClerk('user_clerk_2', 'brand-new@example.com');
  assert.ok(resolved);
  assert.equal(resolved.email, 'brand-new@example.com');

  const row = await prisma.user.findUniqueOrThrow({ where: { id: resolved.id } });
  assert.equal(row.clerkUserId, 'user_clerk_2');
  assert.match(row.passwordHash, /^clerk-managed:/);
  assert.equal(await verifyPassword(row.passwordHash, 'anything'), false);
});

test('no email and no link resolves to null (explicit, no duplicate)', async () => {
  const before = await prisma.user.count();
  const resolved = await resolveMegaUserForClerk('user_clerk_naked', null);
  assert.equal(resolved, null);
  assert.equal(await prisma.user.count(), before);
});
