/**
 * Phase A / P-01: preview endpoint rate limiting.
 *
 * Pure in-memory limiter tests — no DB, no MEGA, no ffmpeg. The HTTP shape
 * is exercised through the same `enforcePreviewRateLimit()` helper the route
 * handlers use, so a 429 + Retry-After is asserted on the real response path.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

type RateLimitModule = typeof import('@/lib/preview/rate-limit');
let rl: RateLimitModule;

const ENV_KEYS = [
  'PREVIEW_RATE_LIMIT_META_PER_MINUTE',
  'PREVIEW_RATE_LIMIT_ASSET_PER_MINUTE',
  'PREVIEW_RATE_LIMIT_ADMIN_GENERATE_PER_MINUTE',
  'PREVIEW_RATE_LIMIT_MAX_KEYS',
  'PREVIEW_RATE_LIMIT_DISABLED',
] as const;

before(async () => {
  rl = await import('@/lib/preview/rate-limit');
});

beforeEach(() => {
  rl.__resetPreviewRateLimitsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
});

function restoreEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

test('requests below the configured limit succeed', () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '3';
  try {
    for (let i = 0; i < 3; i++) {
      const res = rl.enforcePreviewRateLimit('user-a', 'meta', 1_000);
      assert.equal(res, null, `request ${i + 1} allowed`);
    }
    const decision = rl.consumePreviewRateLimit('user-a', 'meta', 1_000);
    assert.equal(decision.allowed, false);
    assert.equal(decision.remaining, 0);
  } finally {
    restoreEnv();
  }
});

test('requests exceeding the limit receive HTTP 429 + Retry-After', async () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '2';
  try {
    assert.equal(rl.enforcePreviewRateLimit('user-a', 'meta', 2_000), null);
    assert.equal(rl.enforcePreviewRateLimit('user-a', 'meta', 2_000), null);
    const res = rl.enforcePreviewRateLimit('user-a', 'meta', 2_000);
    assert.ok(res, 'third request is limited');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.equal(res.headers.get('x-ratelimit-limit'), '2');
    assert.equal(res.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as { error: string; retryAfter: number; scope: string };
    assert.match(body.error, /Too many preview requests/);
    assert.equal(body.retryAfter, 60);
    assert.equal(body.scope, 'meta');
  } finally {
    restoreEnv();
  }
});

test('Retry-After counts down and the window resets', () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '1';
  try {
    const now = 10_000;
    assert.equal(rl.consumePreviewRateLimit('user-a', 'meta', now).allowed, true);
    const blocked = rl.consumePreviewRateLimit('user-a', 'meta', now + 20_000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSec, 40, 'remaining window reported');
    assert.equal(blocked.resetAt, now + 60_000);
    const afterReset = rl.consumePreviewRateLimit('user-a', 'meta', now + 60_000);
    assert.equal(afterReset.allowed, true);
    assert.equal(afterReset.retryAfterSec, 0);
  } finally {
    restoreEnv();
  }
});

test('different authenticated users do not share limits', () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '1';
  try {
    assert.equal(rl.enforcePreviewRateLimit('user-a', 'meta', 3_000), null);
    const blockedA = rl.enforcePreviewRateLimit('user-a', 'meta', 3_000);
    assert.ok(blockedA);
    assert.equal(blockedA.status, 429);
    // A different server-derived identity has its own bucket.
    assert.equal(rl.enforcePreviewRateLimit('user-b', 'meta', 3_000), null);
  } finally {
    restoreEnv();
  }
});

test('the key is user + scope, not a request parameter or video id', () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '2';
  try {
    // Video ids / `want` values are not inputs to the limiter at all; many
    // requests for different videos from one user share one bucket.
    for (let videoId = 1; videoId <= 10; videoId++) {
      rl.consumePreviewRateLimit('user-a', 'meta', 4_000);
    }
    assert.equal(rl.previewRateLimitBucketCount(), 1, 'one counter for the user regardless of video');
    // The asset bucket is separate from meta for the same user.
    assert.equal(rl.enforcePreviewRateLimit('user-a', 'asset', 4_000), null);
    assert.equal(rl.previewRateLimitBucketCount(), 2);
  } finally {
    restoreEnv();
  }
});

test('normal playback is not throttled by preview limits', () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '1';
  try {
    assert.equal(rl.enforcePreviewRateLimit('user-a', 'meta', 5_000), null);
    assert.ok(rl.enforcePreviewRateLimit('user-a', 'meta', 5_000), 'meta exhausted');
    // Media playback routes do not use this limiter. Even preview asset
    // traffic (clip/sprite/VTT) has its own much larger independent budget.
    for (let i = 0; i < 50; i++) {
      assert.equal(rl.enforcePreviewRateLimit('user-a', 'asset', 5_000), null, `asset ${i}`);
    }
  } finally {
    restoreEnv();
  }
});

test('admin generate has its own conservative bucket', () => {
  process.env.PREVIEW_RATE_LIMIT_ADMIN_GENERATE_PER_MINUTE = '1';
  try {
    assert.equal(rl.enforcePreviewRateLimit('user-a', 'admin-generate', 6_000), null);
    const limited = rl.enforcePreviewRateLimit('user-a', 'admin-generate', 6_000);
    assert.ok(limited);
    assert.equal(limited.status, 429);
    // Ordinary meta traffic remains unaffected.
    assert.equal(rl.enforcePreviewRateLimit('user-a', 'meta', 6_000), null);
  } finally {
    restoreEnv();
  }
});

test('kill switch disables counters (emergency operations/tests only)', () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '1';
  process.env.PREVIEW_RATE_LIMIT_DISABLED = '1';
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.enforcePreviewRateLimit('user-a', 'meta', 7_000), null);
    }
    assert.equal(rl.previewRateLimitBucketCount(), 0);
  } finally {
    restoreEnv();
  }
});

test('bucket map stays bounded even for many synthetic identities', () => {
  process.env.PREVIEW_RATE_LIMIT_META_PER_MINUTE = '100';
  process.env.PREVIEW_RATE_LIMIT_MAX_KEYS = '100';
  try {
    for (let i = 0; i < 150; i++) {
      rl.consumePreviewRateLimit(`user-${i}`, 'meta', 8_000);
    }
    assert.ok(rl.previewRateLimitBucketCount() <= 100, 'key cap enforced');
  } finally {
    restoreEnv();
  }
});
