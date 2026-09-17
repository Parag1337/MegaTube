/**
 * Unit tests for the rename/delete video feature.
 *
 *   - lib/mega/nodeOps: attribute-blob round trip (what `a=a` carries),
 *     -9 detection.
 *   - lib/videoRename (service, fake MEGA boundary + real throwaway Postgres):
 *     owner can rename / non-owner rejected / exact node renamed / MEGA
 *     failure leaves the DB untouched / DB failure after MEGA success is
 *     reported explicitly / Creator-Title parsing incl. spaces, extension
 *     exclusion, first-separator-only, no-separator creator preservation.
 *   - lib/videoDelete (service): confirmed delete removes the MEGA node
 *     (shared `a=d` op) + the record / ownership / MEGA failure keeps the
 *     row / already-gone still cleans up.
 *   - Dialogs (server-rendered markup): rename input is prefilled and the
 *     confirm button starts disabled (no accidental rename); the delete
 *     dialog requires an explicit Delete press (rendering never deletes)
 *     and offers Cancel.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('video-rename-delete');
process.env.DATABASE_URL = db.url;
process.env.MEGA_SESSION_ENCRYPTION_KEY = 'cd'.repeat(32);

// NOTE: everything below is imported dynamically in before(): static imports
// would pull in lib/db before DATABASE_URL is set (same pattern as
// media-route.test.ts).
let prisma: typeof import('@/lib/db')['prisma'];
let createMegaAccount: typeof import('@/lib/megaAccounts')['createMegaAccount'];
let encryptSecret: typeof import('@/lib/mega/envelope')['encryptSecret'];
let MegaError: typeof import('@/lib/mega/account')['MegaError'];
let foldFileKey: typeof import('@/lib/mega/nodeOps')['foldFileKey'];
let isNotFoundError: typeof import('@/lib/mega/nodeOps')['isNotFoundError'];
let packNodeNameAttribute: typeof import('@/lib/mega/nodeOps')['packNodeNameAttribute'];
let renameVideo: typeof import('@/lib/videoRename')['renameVideo'];
let RenameError: typeof import('@/lib/videoRename')['RenameError'];
let validateNewFilename: typeof import('@/lib/videoRename')['validateNewFilename'];
let deleteVideo: typeof import('@/lib/videoDelete')['deleteVideo'];
let DeleteVideoError: typeof import('@/lib/videoDelete')['DeleteVideoError'];
let parseVideoMetadata: typeof import('@/lib/titles')['parseVideoMetadata'];

import type { RenameDeps } from '@/lib/videoRename';
import type { DeleteDeps } from '@/lib/videoDelete';

after(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// nodeOps unit tests (no DB)
// ---------------------------------------------------------------------------

test('packNodeNameAttribute round-trips through the folded key (megajs wire format)', () => {
  const fileKey = crypto.randomBytes(32);
  const at = packNodeNameAttribute(fileKey, 'Young Goddess Kim - Some Video.mp4');
  const raw = Buffer.from(at.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', foldFileKey(fileKey), Buffer.alloc(16, 0));
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(raw), decipher.final()]);
  const end = padded.indexOf(0);
  const payload = padded.subarray(0, end === -1 ? undefined : end).toString('utf8');
  assert.equal(payload, 'MEGA{"n":"Young Goddess Kim - Some Video.mp4"}');
});

test('isNotFoundError detects MEGA -9 only', () => {
  assert.equal(isNotFoundError(new Error('whatever (-9)')), true);
  assert.equal(isNotFoundError(new Error('whatever (-15)')), false);
  assert.equal(isNotFoundError(new Error('boom')), false);
});

test('validateNewFilename rejects empty / separators / overlong names', () => {
  assert.equal(validateNewFilename('  A - B.mp4  '), 'A - B.mp4');
  assert.throws(() => validateNewFilename('   '), (e: unknown) => e instanceof RenameError);
  assert.throws(() => validateNewFilename('a/b.mp4'), (e: unknown) => e instanceof RenameError);
  assert.throws(() => validateNewFilename('a\\b.mp4'), (e: unknown) => e instanceof RenameError);
  assert.throws(() => validateNewFilename('x'.repeat(256)), (e: unknown) => e instanceof RenameError);
  assert.throws(() => validateNewFilename(42), (e: unknown) => e instanceof RenameError);
});

// ---------------------------------------------------------------------------
// Parser expectations reused by rename (same lib/titles pipeline as sync)
// ---------------------------------------------------------------------------

test('rename parsing: "Creator - Title.ext" with spaces in the creator', () => {
  const parsed = parseVideoMetadata('Young Goddess Kim - Some Video.mp4');
  assert.equal(parsed.creator, 'Young Goddess Kim');
  assert.equal(parsed.title, 'Some Video');
});

test('rename parsing: extension excluded, first separator only', () => {
  const parsed = parseVideoMetadata('Young Goddess Kim - Amazing Video.mp4');
  assert.equal(parsed.creator, 'Young Goddess Kim');
  assert.equal(parsed.title, 'Amazing Video');
  assert.ok(!parsed.title.includes('.mp4'));
  const multi = parseVideoMetadata('A - B - C.mp4');
  assert.equal(multi.creator, 'A');
  assert.equal(multi.title, 'B - C');
});

test('rename parsing: no separator -> creator null, title preserved', () => {
  const parsed = parseVideoMetadata('Just A Standalone Title.mp4');
  assert.equal(parsed.creator, null);
  assert.equal(parsed.title, 'Just A Standalone Title');
});

// ---------------------------------------------------------------------------
// Service fixtures
// ---------------------------------------------------------------------------

const FILE_KEY = Buffer.alloc(32, 9);

async function makeUser(suffix: string) {
  return prisma.user.create({
    data: {
      email: `rename-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      passwordHash: 'pbkdf2:sha256:100000:00:00',
    },
  });
}

async function makeAccount(userId: string, email: string) {
  return createMegaAccount({
    userId,
    label: `Acc ${email}`,
    email,
    material: {
      v: 1 as const,
      sid: 's'.repeat(60),
      masterKey: Buffer.alloc(16, 1).toString('base64url'),
      rsa: null,
      user: 'Uowner',
      name: 'Owner',
      email,
    },
  });
}

let slugSeq = 0;
async function makeVideo(
  accountId: number,
  opts: { filename: string; creatorId?: number | null; assignment?: string } = {
    filename: 'Old Creator - Old Title.mp4',
  },
) {
  slugSeq += 1;
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaNodeId: `node-${accountId}-${slugSeq}-${Math.random().toString(36).slice(2)}`,
      megaFilename: opts.filename,
      title: 'Old Title',
      slug: `rename-slug-${Date.now()}-${slugSeq}-${Math.random().toString(36).slice(2)}`,
      creatorId: opts.creatorId ?? null,
      creatorAssignment: opts.assignment ?? 'none',
      fileSize: BigInt(1234),
      mimeType: 'video/mp4',
      fileKeyEncrypted: encryptSecret(FILE_KEY),
    },
  });
}

interface MegaSpy {
  renamed: Array<{ nodeId: string; name: string; key: Buffer }>;
  deleted: string[];
  renameBehavior: 'ok' | 'fail' | 'not-found' | 'session-expired' | 'delete-row-then-ok';
  deleteBehavior: 'ok' | 'fail' | 'already-gone' | 'session-expired';
  reauthMarked: number[];
  evicted: number[];
  syncs: number[];
}

function makeSpy(): MegaSpy {
  return {
    renamed: [],
    deleted: [],
    renameBehavior: 'ok',
    deleteBehavior: 'ok',
    reauthMarked: [],
    evicted: [],
    syncs: [],
  };
}

function renameDeps(spy: MegaSpy): RenameDeps {
  return {
    withMegaSession: async (_acc, _enc, fn) => fn({ fake: 'storage' } as never),
    renameMegaNode: async (_storage, nodeId, key, name) => {
      if (spy.renameBehavior === 'fail') throw new Error('MEGA blew up');
      if (spy.renameBehavior === 'not-found') throw new Error('node gone (-9)');
      if (spy.renameBehavior === 'session-expired') {
        throw new MegaError('session-expired', 'dead', -15);
      }
      spy.renamed.push({ nodeId, name, key });
    },
    markAccountReauthRequired: async (id) => {
      spy.reauthMarked.push(id);
    },
    evictMegaSession: (id) => {
      spy.evicted.push(id);
    },
  };
}

function deleteDeps(spy: MegaSpy): DeleteDeps {
  return {
    withMegaSession: async (_acc, _enc, fn) => fn({ fake: 'storage' } as never),
    deleteMegaNode: async (_storage, nodeId) => {
      if (spy.deleteBehavior === 'fail') throw new Error('MEGA blew up');
      if (spy.deleteBehavior === 'already-gone') throw new Error('node gone (-9)');
      if (spy.deleteBehavior === 'session-expired') {
        throw new MegaError('session-expired', 'dead', -15);
      }
      spy.deleted.push(nodeId);
    },
    markAccountReauthRequired: async (id) => {
      spy.reauthMarked.push(id);
    },
    evictMegaSession: (id) => {
      spy.evicted.push(id);
    },
    enqueueSync: async (id) => {
      spy.syncs.push(id);
      return 'queued';
    },
  };
}

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  ({ createMegaAccount } = await import('@/lib/megaAccounts'));
  ({ encryptSecret } = await import('@/lib/mega/envelope'));
  ({ MegaError } = await import('@/lib/mega/account'));
  ({ foldFileKey, isNotFoundError, packNodeNameAttribute } = await import('@/lib/mega/nodeOps'));
  ({ renameVideo, RenameError, validateNewFilename } = await import('@/lib/videoRename'));
  ({ deleteVideo, DeleteVideoError } = await import('@/lib/videoDelete'));
  ({ parseVideoMetadata } = await import('@/lib/titles'));
});

// ---------------------------------------------------------------------------
// renameVideo service
// ---------------------------------------------------------------------------

test('authenticated owner can rename their own video (MEGA node + metadata)', async () => {
  const user = await makeUser('owner1');
  const account = await makeAccount(user.id, 'owner1@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();

  const out = await renameVideo(video.id, user.id, 'Young Goddess Kim - Some Video.mp4', renameDeps(spy));

  // The EXACT node was renamed on MEGA with the right key.
  assert.equal(spy.renamed.length, 1);
  assert.equal(spy.renamed[0].nodeId, video.megaNodeId);
  assert.equal(spy.renamed[0].name, 'Young Goddess Kim - Some Video.mp4');
  assert.ok(spy.renamed[0].key.equals(FILE_KEY));

  // Same record, new metadata, creator assigned from the filename.
  assert.equal(out.id, video.id);
  assert.equal(out.slug, video.slug);
  assert.equal(out.megaFilename, 'Young Goddess Kim - Some Video.mp4');
  assert.equal(out.title, 'Some Video');
  assert.equal(out.creator?.name, 'Young Goddess Kim');
  assert.equal(out.creatorAssignment, 'auto');
  const row = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
  assert.equal(row.megaFilename, 'Young Goddess Kim - Some Video.mp4');
  assert.equal(row.title, 'Some Video');
  assert.equal(row.megaNodeId, video.megaNodeId);
});

test('user cannot rename another user\u2019s video (MEGA untouched)', async () => {
  const owner = await makeUser('owner2');
  const intruder = await makeUser('intruder2');
  const account = await makeAccount(owner.id, 'owner2@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();

  await assert.rejects(
    renameVideo(video.id, intruder.id, 'X - Y.mp4', renameDeps(spy)),
    (e: unknown) => e instanceof RenameError && e.status === 404,
  );
  assert.equal(spy.renamed.length, 0);
  const row = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
  assert.equal(row.megaFilename, video.megaFilename);
});

test('MEGA rename failure does not update the database', async () => {
  const user = await makeUser('owner3');
  const account = await makeAccount(user.id, 'owner3@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();
  spy.renameBehavior = 'fail';

  await assert.rejects(
    renameVideo(video.id, user.id, 'New Creator - New Title.mp4', renameDeps(spy)),
    (e: unknown) => e instanceof RenameError && e.status === 502,
  );
  const row = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
  assert.equal(row.megaFilename, video.megaFilename);
  assert.equal(row.title, video.title);
});

test('MEGA session expiry maps to reconnect (DB untouched)', async () => {
  const user = await makeUser('owner3b');
  const account = await makeAccount(user.id, 'owner3b@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();
  spy.renameBehavior = 'session-expired';

  await assert.rejects(
    renameVideo(video.id, user.id, 'New Creator - New Title.mp4', renameDeps(spy)),
    (e: unknown) => e instanceof RenameError && e.status === 409,
  );
  assert.deepEqual(spy.reauthMarked, [account.id]);
  const row = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
  assert.equal(row.megaFilename, video.megaFilename);
});

test('filename without separator preserves the existing creator', async () => {
  const user = await makeUser('owner4');
  const account = await makeAccount(user.id, 'owner4@example.com');
  const creator = await prisma.creator.create({
    data: { userId: user.id, name: 'Existing Creator', slug: `existing-${Date.now()}` },
  });
  const video = await makeVideo(account.id, {
    filename: 'Existing Creator - Old Title.mp4',
    creatorId: creator.id,
    assignment: 'auto',
  });
  const spy = makeSpy();

  const out = await renameVideo(video.id, user.id, 'Just A Standalone Title.mp4', renameDeps(spy));
  assert.equal(out.title, 'Just A Standalone Title');
  const row = await prisma.video.findUniqueOrThrow({ where: { id: video.id } });
  // No creator pattern -> the association is preserved, never guessed.
  assert.equal(row.creatorId, creator.id);
  assert.equal(row.creatorAssignment, 'auto');
});

test('only the first " - " separates creator from title', async () => {
  const user = await makeUser('owner5');
  const account = await makeAccount(user.id, 'owner5@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();

  const out = await renameVideo(video.id, user.id, 'Kim - Part One - Part Two.mp4', renameDeps(spy));
  assert.equal(out.creator?.name, 'Kim');
  assert.equal(out.title, 'Part One - Part Two');
});

test('MEGA success + DB failure is reported explicitly (megaRenamed)', async () => {
  const user = await makeUser('owner6');
  const account = await makeAccount(user.id, 'owner6@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();
  const deps = renameDeps(spy);
  // Simulate the row disappearing between the MEGA rename and the DB write.
  const origRename = deps.renameMegaNode;
  deps.renameMegaNode = async (s, n, k, name) => {
    await origRename(s, n, k, name);
    await prisma.video.delete({ where: { id: video.id } });
  };
  await assert.rejects(
    renameVideo(video.id, user.id, 'Kim - Fresh.mp4', deps),
    (e: unknown) => e instanceof RenameError && e.status === 502 && e.megaRenamed === true,
  );
  assert.equal(spy.renamed.length, 1);
});

// ---------------------------------------------------------------------------
// deleteVideo service (reuses the shared MEGA `a=d` node op)
// ---------------------------------------------------------------------------

test('confirmed delete removes the MEGA node (shared op) and the record', async () => {
  const user = await makeUser('del1');
  const account = await makeAccount(user.id, 'del1@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();

  const out = await deleteVideo(video.id, user.id, deleteDeps(spy));
  assert.equal(out.id, video.id);
  assert.equal(out.alreadyGone, false);
  // The exact node went through the shared delete op.
  assert.deepEqual(spy.deleted, [video.megaNodeId]);
  assert.equal(await prisma.video.findUnique({ where: { id: video.id } }), null);
  assert.deepEqual(spy.syncs, [account.id]);
});

test('user cannot delete another user\u2019s video (MEGA untouched, row kept)', async () => {
  const owner = await makeUser('del2o');
  const intruder = await makeUser('del2i');
  const account = await makeAccount(owner.id, 'del2o@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();

  await assert.rejects(
    deleteVideo(video.id, intruder.id, deleteDeps(spy)),
    (e: unknown) => e instanceof DeleteVideoError && e.status === 404,
  );
  assert.equal(spy.deleted.length, 0);
  assert.ok(await prisma.video.findUnique({ where: { id: video.id } }));
});

test('delete failure keeps the record (user stays on the page)', async () => {
  const user = await makeUser('del3');
  const account = await makeAccount(user.id, 'del3@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();
  spy.deleteBehavior = 'fail';

  await assert.rejects(
    deleteVideo(video.id, user.id, deleteDeps(spy)),
    (e: unknown) => e instanceof DeleteVideoError && e.status === 502,
  );
  assert.ok(await prisma.video.findUnique({ where: { id: video.id } }));
});

test('already-gone node (-9) still cleans up the record, reported honestly', async () => {
  const user = await makeUser('del4');
  const account = await makeAccount(user.id, 'del4@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();
  spy.deleteBehavior = 'already-gone';

  const out = await deleteVideo(video.id, user.id, deleteDeps(spy));
  assert.equal(out.alreadyGone, true);
  assert.equal(await prisma.video.findUnique({ where: { id: video.id } }), null);
});

test('delete session expiry maps to reconnect (nothing deleted)', async () => {
  const user = await makeUser('del5');
  const account = await makeAccount(user.id, 'del5@example.com');
  const video = await makeVideo(account.id);
  const spy = makeSpy();
  spy.deleteBehavior = 'session-expired';

  await assert.rejects(
    deleteVideo(video.id, user.id, deleteDeps(spy)),
    (e: unknown) => e instanceof DeleteVideoError && e.status === 409,
  );
  assert.deepEqual(spy.reauthMarked, [account.id]);
  assert.ok(await prisma.video.findUnique({ where: { id: video.id } }));
});

// ---------------------------------------------------------------------------
// Dialog markup: confirmation is required, destructive action is gated
// ---------------------------------------------------------------------------

test('rename dialog is prefilled and confirm starts disabled (no accidental rename)', async () => {
  const { renderToString } = await import('react-dom/server');
  const React = await import('react');
  const { VideoRenameDialog } = await import('@/components/VideoRenameDialog');
  const html = renderToString(
    React.createElement(VideoRenameDialog, {
      videoId: 1,
      currentFilename: 'Kim - Hit.mp4',
      open: true,
      onClose: () => {},
      onRenamed: () => {},
    }),
  );
  // Input initially contains the current filename...
  assert.match(html, /value="Kim - Hit\.mp4"/);
  // ...and Rename is disabled until the name actually changes.
  assert.match(html, /disabled[^>]*>\s*Rename\s*</);
});

test('delete dialog requires an explicit Delete press (render never deletes)', async () => {
  const { renderToString } = await import('react-dom/server');
  const React = await import('react');
  const { VideoDeleteDialog } = await import('@/components/VideoDeleteDialog');
  let deleted = false;
  const html = renderToString(
    React.createElement(VideoDeleteDialog, {
      videoId: 1,
      videoTitle: 'Kim - Hit',
      open: true,
      onClose: () => {},
      onDeleted: () => {
        deleted = true;
      },
    }),
  );
  assert.equal(deleted, false);
  assert.match(html, /Cancel/);
  // Destructive action is visually distinct.
  assert.match(html, /text-destructive/);
});
