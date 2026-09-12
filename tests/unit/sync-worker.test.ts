/**
 * Phase 3 tests: the sync worker (lib/sync/syncAccount.ts) against a REAL
 * temporary SQLite database, with the MEGA network boundary fully mocked.
 *
 * The worker's MEGA boundary is injectable (SyncDeps) exactly so these tests
 * exist: syncMegaAccount is called with fake `withMegaSession` +
 * `fetchAccountFileNodes`. NO real MEGA network call, NO credentials, NO
 * destructive operations are possible - the fake API client only accepts
 * read-only commands and every issued command is recorded and asserted.
 *
 * Spec items covered here:
 *   sync creation/update/stale removal, node-ID matching (never filename),
 *   duplicate prevention, empty remote set, user + account isolation,
 *   invalid session -> REAUTH_REQUIRED (videos preserved),
 *   successful sync metadata (durable lastSyncMeta),
 *   background execution, live progress updates incl. no fake percentage
 *   before the total is known, progress reaching completion,
 *   no duplicate simultaneous sync, no password login during sync,
 *   no destructive MEGA operations.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';
import type { SyncDeps } from '@/lib/sync/syncAccount';
import type { DecodedFileNode } from '@/lib/mega/nodes';

const db = createTestDatabase('sync-worker-unit');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'ab'.repeat(32);

let prisma: typeof import('@/lib/db')['prisma'];
let accounts: typeof import('@/lib/megaAccounts');
let syncMegaAccount: typeof import('@/lib/sync/syncAccount')['syncMegaAccount'];
let getSyncProgress: typeof import('@/lib/sync/progress')['getSyncProgress'];
let MegaError: typeof import('@/lib/mega/account')['MegaError'];
let MEGA_ACCOUNT_STATUSES: (typeof import('@/lib/megaAccounts'))['MEGA_ACCOUNT_STATUSES'];

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  accounts = await import('@/lib/megaAccounts');
  ({ syncMegaAccount } = await import('@/lib/sync/syncAccount'));
  ({ getSyncProgress } = await import('@/lib/sync/progress'));
  ({ MegaError } = await import('@/lib/mega/account'));
  ({ MEGA_ACCOUNT_STATUSES } = accounts);
});

after(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Fake MEGA boundary
// ---------------------------------------------------------------------------

const FILE_KEY = Buffer.alloc(32, 9);

/** Read-only commands a legitimate sync may issue against MEGA. */
const ALLOWED_COMMANDS = new Set(['ug', 'f', 'ufa', 'g']);
/** MEGA commands that mutate anything - must never appear. */
const DESTRUCTIVE_COMMANDS = new Set(['u', 'd', 'm', 'p', 's', 's2', 'l', 'k', 'us', 'up']);

function videoNode(handle: string, overrides: Partial<DecodedFileNode> = {}): DecodedFileNode {
  return {
    h: handle,
    p: 'folder1',
    t: 0,
    ts: 1_700_000_000,
    s: 1_234,
    u: 'Uowner',
    name: `${handle}.mp4`,
    fa: '1:0*thumbA/1:8*mediaB',
    fileKey: FILE_KEY,
    ...overrides,
  };
}

interface SceneState {
  nodes: DecodedFileNode[];
  /** When set, fetchAccountFileNodes blocks until released (background tests). */
  gate: Promise<void> | null;
  releaseGate: (() => void) | null;
  failSessionWith: 'session-expired' | 'transient' | null;
}

const scene: SceneState = {
  nodes: [],
  gate: null,
  releaseGate: null,
  failSessionWith: null,
};

interface FakeMega {
  deps: SyncDeps;
  commands: string[];
  withMegaSessionCalls: number;
  fetchCalls: number;
  /** encryptedSession value passed to withMegaSession, per account. */
  sessionsSeen: Map<number, string>;
}

function makeFakeMega(): FakeMega {
  const commands: string[] = [];
  const sessionsSeen = new Map<number, string>();
  const fake: FakeMega = { deps: undefined as unknown as SyncDeps, commands, withMegaSessionCalls: 0, fetchCalls: 0, sessionsSeen };

  const fakeStorage = {
    key: Buffer.alloc(16, 3),
    user: 'Uowner',
    api: {
      request: async (cmd: Record<string, unknown>) => {
        commands.push(String(cmd.a));
        // ufa (attribute URL) answers with no URL -> the worker skips the
        // attribute fetch entirely; nothing ever leaves this process.
        return null;
      },
    },
  };

  fake.deps = {
    withMegaSession: async (_accountId, encryptedSession, fn) => {
      fake.withMegaSessionCalls++;
      sessionsSeen.set(_accountId, encryptedSession);
      if (scene.failSessionWith === 'session-expired') {
        throw new MegaError('session-expired', 'Stored MEGA session rejected (-15)');
      }
      if (scene.failSessionWith === 'transient') {
        throw new MegaError('transient', 'server returned error');
      }
      return fn(fakeStorage as never);
    },
    fetchAccountFileNodes: async (_storage, onScanProgress) => {
      fake.fetchCalls++;
      onScanProgress?.(50);
      onScanProgress?.(120);
      if (scene.gate) await scene.gate;
      return scene.nodes;
    },
  };
  return fake;
}

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `worker-${suffix}@example.com`,
      passwordHash:
        'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000',
    },
  });
}

async function link(userId: string, email: string) {
  return accounts.createMegaAccount({
    userId,
    label: `Acc ${email}`,
    email,
    material: {
      v: 1 as const,
      sid: 'x'.repeat(58),
      masterKey: Buffer.alloc(16, 1).toString('base64url'),
      rsa: null,
      user: 'Uowner',
      name: 'Owner',
      email,
    },
  });
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met in time: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function videoCount(accountId: number): Promise<number> {
  return prisma.video.count({ where: { megaAccountId: accountId } });
}

async function rowsOf(accountId: number) {
  return prisma.video.findMany({ where: { megaAccountId: accountId }, orderBy: { id: 'asc' } });
}

// ---------------------------------------------------------------------------
// Creation / update / removal / identity
// ---------------------------------------------------------------------------

test('sync creation: remote video nodes become Video rows', async () => {
  const u = await makeUser('create');
  const acc = await link(u.id, 'create@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2')];
  const fake = makeFakeMega();

  const result = await syncMegaAccount(acc.id, fake.deps);
  assert.ok(result, 'sync must run');
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.removed, 0);
  assert.equal(await videoCount(acc.id), 2);

  const rows = await rowsOf(acc.id);
  assert.deepEqual(rows.map((r) => r.megaNodeId).sort(), ['v1', 'v2']);
  assert.equal(rows[0].mimeType, 'video/mp4');
  assert.equal(rows[0].megaFilename, 'v1.mp4');
  assert.ok(rows[0].slug.length > 0);
  // videoCount + status only updated AFTER reconciliation completed.
  const after = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(after.status, MEGA_ACCOUNT_STATUSES.SYNCED);
  assert.equal(after.videoCount, 2);
  assert.ok(after.lastSyncCompletedAt);
});

test('sync update: changed remote metadata updates the existing row', async () => {
  const u = await makeUser('update');
  const acc = await link(u.id, 'update@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2')];
  await syncMegaAccount(acc.id, makeFakeMega().deps);

  // v1 renamed and resized; identity (node handle) unchanged.
  scene.nodes = [videoNode('v1', { name: 'renamed.mp4', s: 9_999, ts: 1_700_000_500 }), videoNode('v2')];
  const fake = makeFakeMega();
  const result = await syncMegaAccount(acc.id, fake.deps);

  assert.ok(result);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.removed, 0);
  assert.equal(await videoCount(acc.id), 2, 'update must not duplicate');

  const rows = await rowsOf(acc.id);
  const v1 = rows.find((r) => r.megaNodeId === 'v1')!;
  assert.equal(v1.megaFilename, 'renamed.mp4');
  assert.equal(v1.fileSize, BigInt(9_999));
  const v2 = rows.find((r) => r.megaNodeId === 'v2')!;
  assert.equal(v2.megaFilename, 'v2.mp4', 'untouched node keeps its row');
});

test('stale removal: DB rows without a remote node are removed', async () => {
  const u = await makeUser('stale-rm');
  const acc = await link(u.id, 'stale-rm@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2')];
  await syncMegaAccount(acc.id, makeFakeMega().deps);
  assert.equal(await videoCount(acc.id), 2);

  scene.nodes = [videoNode('v1')]; // v2 vanished from MEGA
  const fake = makeFakeMega();
  const result = await syncMegaAccount(acc.id, fake.deps);

  assert.ok(result);
  assert.equal(result.removed, 1);
  assert.equal(await videoCount(acc.id), 1);
  const handles = (await rowsOf(acc.id)).map((r) => r.megaNodeId);
  assert.deepEqual(handles, ['v1']);
});

test('identity is the MEGA node id, never the filename', async () => {
  const u = await makeUser('identity');
  const acc = await link(u.id, 'identity@example.com');
  scene.nodes = [videoNode('v1', { name: 'same-name.mp4' })];
  await syncMegaAccount(acc.id, makeFakeMega().deps);

  // A NEW node handle carrying the SAME filename = re-upload: add + remove.
  scene.nodes = [videoNode('v1b', { name: 'same-name.mp4' })];
  const fake = makeFakeMega();
  const result = await syncMegaAccount(acc.id, fake.deps);

  assert.ok(result);
  assert.equal(result.added, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.updated, 0, 'different node handle must never match by filename');

  const rows = await rowsOf(acc.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].megaNodeId, 'v1b');
  assert.equal(rows[0].megaFilename, 'same-name.mp4');
});

test('duplicate prevention: repeated identical syncs create no duplicates', async () => {
  const u = await makeUser('dupes');
  const acc = await link(u.id, 'dupes@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2'), videoNode('v3')];
  await syncMegaAccount(acc.id, makeFakeMega().deps);
  const second = await syncMegaAccount(acc.id, makeFakeMega().deps);

  assert.ok(second);
  assert.equal(second.added, 0);
  assert.equal(second.unchanged, 3, 'identical rows are verified, not rewritten');
  assert.equal(await videoCount(acc.id), 3, 'row count must stay stable');
});

test('empty remote video set removes all rows and completes cleanly', async () => {
  const u = await makeUser('empty');
  const acc = await link(u.id, 'empty@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2')];
  await syncMegaAccount(acc.id, makeFakeMega().deps);

  scene.nodes = [];
  const fake = makeFakeMega();
  const result = await syncMegaAccount(acc.id, fake.deps);

  assert.ok(result);
  assert.equal(result.removed, 2);
  assert.equal(result.total, 0);
  assert.equal(await videoCount(acc.id), 0);
  const after = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(after.status, MEGA_ACCOUNT_STATUSES.SYNCED, 'a completed empty sync is still a successful sync');
  assert.equal(after.videoCount, 0);
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test('user isolation: a sync never touches another user account or videos', async () => {
  const a = await makeUser('iso-a');
  const b = await makeUser('iso-b');
  const accA = await link(a.id, 'iso-a-mega@example.com');
  const accB = await link(b.id, 'iso-b-mega@example.com');

  // User B already has a video row for their own account.
  const bRow = await prisma.video.create({
    data: {
      megaAccountId: accB.id,
      megaNodeId: 'bnode',
      megaFilename: 'userb.mp4',
      title: 'User B Video',
      slug: `userb-${accB.id}`,
      fileSize: BigInt(7),
      creatorAssignment: 'none',
    },
  });

  scene.nodes = [videoNode('v1'), videoNode('v2')];
  const fake = makeFakeMega();
  const result = await syncMegaAccount(accA.id, fake.deps);
  assert.ok(result);

  // All created rows belong to account A only.
  const aRows = await rowsOf(accA.id);
  assert.equal(aRows.length, 2);
  assert.ok(aRows.every((r) => r.megaAccountId === accA.id));
  assert.ok(aRows.every((r) => r.megaNodeId !== 'bnode'));

  // User B's data is byte-identical to before.
  const bAfter = await prisma.video.findUniqueOrThrow({ where: { id: bRow.id } });
  assert.equal(bAfter.megaNodeId, 'bnode');
  assert.equal(bAfter.megaFilename, 'userb.mp4');
  assert.equal(await videoCount(accB.id), 1);

  // Account B itself was not claimed or modified by A's sync.
  const accBAfter = await prisma.megaAccount.findUniqueOrThrow({ where: { id: accB.id } });
  assert.equal(accBAfter.status, MEGA_ACCOUNT_STATUSES.CONNECTED, 'B stays CONNECTED (not synced by A)');
  assert.equal(accBAfter.lastSyncMeta, null);
  assert.equal(accBAfter.lastSyncCompletedAt, null);
});

test('account isolation: syncing account #1 never modifies sibling account #2 of the SAME user', async () => {
  const u = await makeUser('sibling');
  const acc1 = await link(u.id, 'sib1@example.com');
  const acc2 = await link(u.id, 'sib2@example.com');

  const sibRow = await prisma.video.create({
    data: {
      megaAccountId: acc2.id,
      megaNodeId: 'sibnode',
      megaFilename: 'sibling.mp4',
      title: 'Sibling',
      slug: `sibling-${acc2.id}`,
      fileSize: BigInt(3),
      creatorAssignment: 'none',
    },
  });

  scene.nodes = [videoNode('v1')];
  const result = await syncMegaAccount(acc1.id, makeFakeMega().deps);
  assert.ok(result);

  const sibAfter = await prisma.video.findUniqueOrThrow({ where: { id: sibRow.id } });
  assert.equal(sibAfter.megaNodeId, 'sibnode');
  assert.equal(await videoCount(acc2.id), 1, 'sibling account videos untouched');
  const acc2After = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc2.id } });
  assert.equal(acc2After.status, MEGA_ACCOUNT_STATUSES.CONNECTED);
  assert.equal(acc2After.lastSyncCompletedAt, null);
});

// ---------------------------------------------------------------------------
// Session/expiry handling
// ---------------------------------------------------------------------------

test('invalid session -> REAUTH_REQUIRED, video rows preserved, never SYNCED', async () => {
  const u = await makeUser('expired');
  const acc = await link(u.id, 'expired@example.com');
  scene.nodes = [videoNode('v1')];
  await syncMegaAccount(acc.id, makeFakeMega().deps);
  assert.equal(await videoCount(acc.id), 1);

  scene.failSessionWith = 'session-expired';
  try {
    const result = await syncMegaAccount(acc.id, makeFakeMega().deps);
    assert.equal(result, null, 'failed sync returns null');

    const after = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
    assert.equal(after.status, MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED);
    assert.notEqual(after.lastSyncError, null);
    assert.equal(await videoCount(acc.id), 1, 'video rows are preserved for reconciliation later');
    assert.equal(after.videoCount, 1);
    // meta marks the failure durably
    const meta = JSON.parse(after.lastSyncMeta ?? '{}') as { outcome?: string };
    assert.equal(meta.outcome, 'failed');
  } finally {
    scene.failSessionWith = null;
  }
});

test('transient failure -> ERROR (retryable), not REAUTH_REQUIRED', async () => {
  const u = await makeUser('transient');
  const acc = await link(u.id, 'transient@example.com');

  scene.failSessionWith = 'transient';
  try {
    const result = await syncMegaAccount(acc.id, makeFakeMega().deps);
    assert.equal(result, null);
    const after = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
    assert.equal(after.status, MEGA_ACCOUNT_STATUSES.ERROR);
    assert.equal(after.consecutiveSyncFailures, 1);
  } finally {
    scene.failSessionWith = null;
  }
});

// ---------------------------------------------------------------------------
// Durable sync metadata
// ---------------------------------------------------------------------------

test('successful sync persists lastSyncMeta and exposes it through the public API shape', async () => {
  const u = await makeUser('meta');
  const acc = await link(u.id, 'meta@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2'), videoNode('v3')];
  const result = await syncMegaAccount(acc.id, makeFakeMega().deps);
  assert.ok(result);

  const after = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.ok(after.lastSyncMeta, 'lastSyncMeta must be persisted in the DB');
  const meta = JSON.parse(after.lastSyncMeta) as {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    discovered: number;
    totalVideos: number;
    created: number;
    updated: number;
    removed: number;
    unchanged: number;
    outcome: string;
  };
  assert.equal(meta.outcome, 'completed');
  assert.equal(meta.discovered, 3);
  assert.equal(meta.totalVideos, 3);
  assert.equal(meta.created, 3);
  assert.equal(meta.updated, 0);
  assert.equal(meta.removed, 0);
  assert.equal(meta.unchanged, 0);
  assert.ok(meta.durationMs >= 0);
  assert.ok(new Date(meta.completedAt).getTime() >= new Date(meta.startedAt).getTime());

  // The API/Ui path parses the JSON into an object (never a raw string).
  const pub = await accounts.listMegaAccountsForUser(u.id);
  const mine = pub.find((p) => p.id === acc.id)!;
  assert.equal(typeof mine.lastSyncMeta, 'object');
  assert.equal(mine.lastSyncMeta!.outcome, 'completed');
});

// ---------------------------------------------------------------------------
// Progress: phases, no fake %, background execution, completion
// ---------------------------------------------------------------------------

test('background sync: progress is observable mid-flight, no fake % while scanning, reaches completion', async () => {
  const u = await makeUser('progress');
  const acc = await link(u.id, 'progress@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2')];

  // Gate the scan so we can observe the in-flight state.
  let release!: () => void;
  scene.gate = new Promise<void>((r) => {
    release = r;
  });

  const fake = makeFakeMega();
  // NOT awaited: sync must run in the background while the caller proceeds.
  const job = syncMegaAccount(acc.id, fake.deps);

  // Phase A: scanning - total unknown, nodes counter live, NO percentage basis.
  await waitFor(() => {
    const p = getSyncProgress(acc.id);
    return p?.phase === 'scanning' && p.nodesScanned === 120;
  }, 'scanning progress visible mid-flight');
  const scanning = getSyncProgress(acc.id)!;
  assert.equal(scanning.totalVideos, null, 'totalVideos must be null while scanning (no fake percentage)');
  assert.ok(scanning.startedAt > 0);

  release();
  const result = await job;

  assert.ok(result, 'background job completes');
  assert.equal(result.added, 2);

  // Phase B happened: after completion the total was known and reached.
  const meta = JSON.parse(
    (await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } })).lastSyncMeta ?? '{}',
  ) as { totalVideos: number; created: number };
  assert.equal(meta.totalVideos, 2);
  assert.equal(meta.created, 2);

  // Progress is cleared once the job finishes (no stale bars).
  assert.equal(getSyncProgress(acc.id), null);
  scene.gate = null;
});

test('no duplicate simultaneous sync: a second job for the same account is a no-op', async () => {
  const u = await makeUser('no-double');
  const acc = await link(u.id, 'no-double@example.com');
  scene.nodes = [videoNode('v1'), videoNode('v2')];

  let release!: () => void;
  scene.gate = new Promise<void>((r) => {
    release = r;
  });

  const fake = makeFakeMega();
  const first = syncMegaAccount(acc.id, fake.deps);

  // Wait until the first job holds the claim.
  await waitFor(() => fake.fetchCalls === 1, 'first job reached the scan');

  const second = await syncMegaAccount(acc.id, makeFakeMega().deps);
  assert.equal(second, null, 'second concurrent sync must be rejected by the claim gate');

  release();
  const r1 = await first;
  assert.ok(r1);
  assert.equal(fake.fetchCalls, 1, 'only ONE scan ever ran');
  assert.equal(await videoCount(acc.id), 2, 'videos created exactly once');
  assert.equal(getSyncProgress(acc.id), null);

  // The gate is free again: a new sync can be claimed afterwards.
  const third = await syncMegaAccount(acc.id, makeFakeMega().deps);
  assert.ok(third);
  assert.equal(third.added, 0);
  scene.gate = null;
});

// ---------------------------------------------------------------------------
// MEGA safety
// ---------------------------------------------------------------------------

test('no password login and no destructive MEGA operations during sync', async () => {
  const u = await makeUser('readonly');
  const acc = await link(u.id, 'readonly@example.com');
  scene.nodes = [videoNode('v1')];

  const fake = makeFakeMega();
  await syncMegaAccount(acc.id, fake.deps);

  // 1. The worker received the STORED ENCRYPTED SESSION blob - never a
  //    password, and there is no login capability on the deps interface.
  const seen = fake.sessionsSeen.get(acc.id)!;
  assert.ok(seen.startsWith('v1.'), 'sync resumes the encrypted session blob');
  assert.ok(!Object.prototype.hasOwnProperty.call(fake.deps, 'loginToMega'));
  assert.equal(Object.keys(fake.deps).sort().join(','), 'fetchAccountFileNodes,withMegaSession');

  // 2. Only read-only MEGA commands were issued.
  assert.ok(fake.commands.length > 0, 'the fake API observed the sync');
  for (const cmd of fake.commands) {
    assert.ok(ALLOWED_COMMANDS.has(cmd), `command ${cmd} must be read-only`);
    assert.ok(!DESTRUCTIVE_COMMANDS.has(cmd), `command ${cmd} is destructive and forbidden`);
  }
});

// Thumbnails must never fail a sync: when the MEGA thumbnail/media attribute
// fetch throws, the video row is still created (playable, key stored) with a
// null thumbnail, and the sync reports success.
test('thumbnail attribute failure never fails the sync (row created, playable)', async () => {
  const u = await makeUser('thumbfail');
  const acc = await link(u.id, 'thumbfail@example.com');
  scene.nodes = [videoNode('tf1')];
  const storage = {
    key: Buffer.alloc(16, 3),
    user: 'Uowner',
    api: {
      request: async (cmd: Record<string, unknown>) => {
        if (cmd.a === 'ufa') throw new Error('transient attribute outage');
        return null;
      },
    },
  };
  const deps: SyncDeps = {
    withMegaSession: async (_accountId, _encryptedSession, fn) => fn(storage as never),
    fetchAccountFileNodes: async () => scene.nodes,
  };
  const result = await syncMegaAccount(acc.id, deps);
  assert.ok(result, 'sync must succeed despite thumbnail failure');
  assert.equal(result.added, 1);
  const rows = await rowsOf(acc.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].thumbnail, null);
  assert.equal(rows[0].thumbnailAvailable, true, 'MEGA still advertises a thumbnail');
  assert.ok(rows[0].fileKeyEncrypted, 'playback key stored - video stays playable');
  const after = await prisma.megaAccount.findUniqueOrThrow({ where: { id: acc.id } });
  assert.equal(after.status, MEGA_ACCOUNT_STATUSES.SYNCED);
});
