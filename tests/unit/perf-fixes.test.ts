/**
 * PERF fixes: unit tests for the localhost performance investigation
 * (docs/LOCALHOST-PERFORMANCE-INVESTIGATION.md).
 *
 * Covers:
 *   - TtlMemo: TTL expiry, in-flight sharing (N concurrent callers -> ONE
 *     lookup), invalidation, disabled mode, failure non-memoization.
 *   - withMegaSession single-flight: concurrent cold callers share ONE
 *     resume; failures are never memoized; cache reuse avoids resumes.
 *   - isRemoteDatabaseUrl classification.
 *
 * All DB/MEGA boundaries are faked - no network, no real database needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TtlMemo } from '@/lib/user-memo';
import {
  __setMegaSessionLegsForTests,
  evictAllMegaSessions,
  withMegaSession,
} from '@/lib/sync/session-cache';
import { isRemoteDatabaseUrl } from '@/lib/db';

test('TtlMemo: resolves through the lookup and memoizes', async () => {
  const memo = new TtlMemo<string>(50);
  let calls = 0;
  const lookup = async () => {
    calls++;
    return `u${calls}`;
  };
  assert.equal(await memo.resolve('k', lookup), 'u1');
  assert.equal(await memo.resolve('k', lookup), 'u1');
  assert.equal(calls, 1);
});

test('TtlMemo: concurrent callers share one in-flight lookup', async () => {
  const memo = new TtlMemo<string>(50);
  let calls = 0;
  const result = await Promise.all(
    Array.from({ length: 12 }, () =>
      memo.resolve('k', async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return 'shared';
      }),
    ),
  );
  assert.equal(calls, 1, 'concurrent callers must share a single lookup');
  assert.equal(new Set(result).size, 1);
});

test('TtlMemo: TTL expiry re-lookup, invalidation re-lookup, disabled mode', async () => {
  const memo = new TtlMemo<string>(20);
  let calls = 0;
  const lookup = async () => `v${++calls}`;
  assert.equal(await memo.resolve('k', lookup), 'v1');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(await memo.resolve('k', lookup), 'v2', 'expired entry re-looks-up');
  memo.invalidate('k');
  assert.equal(await memo.resolve('k', lookup), 'v3');

  const off = new TtlMemo<string>(0);
  let calls2 = 0;
  const lookup2 = async () => `w${++calls2}`;
  await off.resolve('k', lookup2);
  await off.resolve('k', lookup2);
  assert.equal(calls2, 2, 'ttl 0 must bypass the memo entirely');
});

test('TtlMemo: lookup failures are not memoized', async () => {
  const memo = new TtlMemo<string>(50);
  let calls = 0;
  const failing = async () => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return 'ok';
  };
  await assert.rejects(() => memo.resolve('k', failing), /boom/);
  assert.equal(await memo.resolve('k', failing), 'ok');
});

// ---------------------------------------------------------------------------
// withMegaSession single-flight via the __setMegaSessionLegsForTests seam
// ---------------------------------------------------------------------------

const sessionCache = {
  __setMegaSessionLegsForTests,
  evictAllMegaSessions,
  withMegaSession,
};

const STORAGE = { fake: true } as unknown as import('megajs').Storage;

function installFakes(options: { openDelayMs?: number; failOpen?: boolean }) {
  let resumeCalls = 0;
  sessionCache.__setMegaSessionLegsForTests({
    decrypt: () => Buffer.from(JSON.stringify({ v: 1, sid: 'x', masterKey: 'y', rsa: null, user: 'U', name: 'n', email: 'e' })),
    validate: () => true,
    open: async () => {
      resumeCalls++;
      if (options.openDelayMs) await new Promise((r) => setTimeout(r, options.openDelayMs));
      if (options.failOpen) throw new Error('mega down');
      return STORAGE;
    },
  });
  sessionCache.evictAllMegaSessions();
  return {
    calls: () => resumeCalls,
    restore: () => {
      sessionCache.__setMegaSessionLegsForTests(null);
      sessionCache.evictAllMegaSessions();
    },
  };
}

test('withMegaSession: concurrent cold callers share ONE resume', async () => {
  const f = installFakes({ openDelayMs: 20 });
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        sessionCache.withMegaSession(4242, 'v1.blob', async (storage) => storage),
      ),
    );
    assert.equal(f.calls(), 1, 'ten concurrent cold callers must trigger exactly one resume');
    assert.equal(new Set(results).size, 1);
  } finally {
    f.restore();
  }
});

test('withMegaSession: warm cache avoids resumes entirely', async () => {
  const f = installFakes({ openDelayMs: 5 });
  try {
    await sessionCache.withMegaSession(4243, 'v1.blob', async () => null);
    await sessionCache.withMegaSession(4243, 'v1.blob', async () => null);
    await sessionCache.withMegaSession(4243, 'v1.blob', async () => null);
    assert.equal(f.calls(), 1);
  } finally {
    f.restore();
  }
});

test('withMegaSession: failed resumes are never memoized (each caller can retry)', async () => {
  const f = installFakes({ failOpen: true });
  try {
    const attempt = () =>
      sessionCache.withMegaSession(4244, 'v1.blob', async () => 'never').then(
        () => 'unexpected success',
        (err: Error) => err.message,
      );
    const [a, b] = await Promise.all([attempt(), attempt()]);
    assert.ok(a.includes('mega down'), 'shared failure reaches concurrent waiters');
    assert.ok(b.includes('mega down'));
    assert.equal(f.calls(), 1, 'concurrent failures still share the single in-flight resume');
    await assert.rejects(
      () => sessionCache.withMegaSession(4244, 'v1.blob', async () => 'never'),
      /mega down/,
      'a NEW caller after a settled failure gets a fresh attempt',
    );
    assert.equal(f.calls(), 2);
  } finally {
    f.restore();
  }
});

test('isRemoteDatabaseUrl: local vs remote classification', async () => {
  assert.equal(isRemoteDatabaseUrl('postgresql://u:p@localhost:5433/db'), false);
  assert.equal(isRemoteDatabaseUrl('postgresql://u:p@127.0.0.1:5433/db'), false);
  assert.equal(
    isRemoteDatabaseUrl('postgresql://u:p@dpg-xxx-a.singapore-postgres.render.com/db?sslmode=require'),
    true,
  );
  assert.equal(isRemoteDatabaseUrl(undefined), false);
});
