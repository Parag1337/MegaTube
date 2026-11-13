/**
 * Regression: a revoked/expired MEGA session is an account-level condition.
 *
 * It must be classified as a non-retryable `source_unavailable` failure so
 * the worker stops burning the attempt budget on guaranteed failures and the
 * UI can offer Reconnect. Transient network errors must keep retrying.
 *
 * All dependencies are fakes; no MEGA, ffmpeg, prisma or real previews.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-preview-session-expiry-'));
process.env.PREVIEW_CACHE_DIR = dir;
process.env.PREVIEW_TOUCH_INTERVAL_MS = '0';

type ServiceModule = typeof import('@/lib/preview/service');
let svc: ServiceModule;

before(async () => {
  svc = await import('@/lib/preview/service');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function videoRow(): svc.PreviewVideoRow {
  return {
    id: 701,
    megaNodeId: 'node-701',
    fileKeyEncrypted: 'v1.fake',
    mimeType: 'video/mp4',
    fileSize: 1000n,
    duration: 100,
    mp4Faststart: true,
    megaAccount: { id: 1, userId: 'user-1', status: 'CONNECTED', encryptedSession: 'sess' },
  };
}

function depsThrowing(message: string): svc.PreviewServiceDeps {
  return {
    loadVideo: async () => null,
    decryptFileKey: () => Buffer.alloc(16, 1),
    sourceDeps: {
      fetchCiphertext: async () => {
        throw new Error('unexpected fetch');
      },
      withSession: async () => {
        throw new Error(message);
      },
      getDownloadUrl: async () => {
        throw new Error('unexpected MEGA URL');
      },
      readWarmCache: async () => null,
    },
    readWarmCache: async () => null,
    queue: {
      has: () => false,
      enqueue: async () => 'completed',
      enqueueNow: () => 'started',
      snapshot: () => ({ running: 0, queued: 0, maxConcurrent: 1, maxQueue: 8 }),
    } as unknown as svc.PreviewServiceDeps['queue'],
    now: () => Date.now(),
  };
}

for (const message of [
  'MEGA session expired or was revoked. Reconnect required.',
  'Stored MEGA session could not be decrypted',
  'Reconnect required for this MEGA account',
]) {
  test(`session failure is non-retryable source_unavailable: ${message}`, async () => {
    const outcome = await svc.generateHoverForWorker(videoRow(), depsThrowing(message));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, 'source_unavailable');
    assert.equal(outcome.retryable, false);
  });
}

test('a source-acquisition timeout is retryable and reported as a download timeout', async () => {
  const outcome = await svc.generateHoverForWorker(
    videoRow(),
    depsThrowing('preview source fetch timed out'),
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, 'download_timeout');
  assert.equal(outcome.retryable, true);
});

test('a transient ciphertext failure remains retryable', async () => {
  const outcome = await svc.generateHoverForWorker(
    videoRow(),
    depsThrowing('ciphertext fetch failed'),
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, 'download_failed');
  assert.equal(outcome.retryable, true);
});
