/**
 * Unit tests for the media route's HTTP Range parsing (parseRange).
 *
 * Contract under test (shared by the direct-stream, warm-cache and 416
 * paths):
 *   - null header            -> null (full resource, 200)
 *   - malformed header       -> 'invalid' (416)
 *   - suffix ranges (-N)     -> last N bytes, clamped to size
 *   - open-ended ranges (N-) -> N..size-1
 *   - closed ranges (N-M)    -> clamped to size-1
 *   - unsatisfiable (start >= size, suffix 0, empty both sides,
 *     end < start, non-integer values) -> 'invalid' (416)
 *
 * Regression coverage for the Phase 1 test matrix item "Range parsing",
 * including suffix ranges and 416 semantics that were previously only
 * exercised indirectly through DB-backed integration tests.
 */

// The route module (transitively lib/db) needs DATABASE_URL at import time,
// and ESM imports are hoisted before plain statements — so the route is
// loaded with a dynamic import AFTER the environment defaults below.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public';
process.env.MEGA_SESSION_ENCRYPTION_KEY = process.env.MEGA_SESSION_ENCRYPTION_KEY ?? 'ab'.repeat(32);

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { parseRange as ParseRangeFn } from '@/app/api/media/[videoId]/route';

let parseRange: typeof ParseRangeFn;
before(async () => {
  ({ parseRange } = await import('@/app/api/media/[videoId]/route'));
});

const SIZE = 1000;

test('parseRange: no header -> null (full resource)', () => {
  assert.equal(parseRange(null, SIZE), null);
});

test('parseRange: open-ended range covers to the last byte', () => {
  assert.deepEqual(parseRange('bytes=0-', SIZE), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=250-', SIZE), { start: 250, end: 999 });
});

test('parseRange: closed range is honored and end-clamped to size-1', () => {
  assert.deepEqual(parseRange('bytes=0-1023', SIZE), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=100-199', SIZE), { start: 100, end: 199 });
});

test('parseRange: suffix range (-N) selects the LAST N bytes', () => {
  assert.deepEqual(parseRange('bytes=-100', SIZE), { start: 900, end: 999 });
  // Suffix larger than the resource -> whole resource.
  assert.deepEqual(parseRange('bytes=-5000', SIZE), { start: 0, end: 999 });
  assert.deepEqual(parseRange(`bytes=-${SIZE}`, SIZE), { start: 0, end: 999 });
});

test('parseRange: byte 0..size-1 (full-range header) -> 0..size-1', () => {
  assert.deepEqual(parseRange('bytes=0-999', SIZE), { start: 0, end: 999 });
});

test('parseRange: malformed headers are invalid (416)', () => {
  assert.equal(parseRange('bytes=', SIZE), 'invalid');
  assert.equal(parseRange('bytes=-', SIZE), 'invalid');
  assert.equal(parseRange('bytes=abc-def', SIZE), 'invalid');
  assert.equal(parseRange('units=0-99', SIZE), 'invalid');
  // Multi-range requests are not supported -> treated as malformed.
  assert.equal(parseRange('bytes=0-9,50-59', SIZE), 'invalid');
  // Floating point / exponent forms are not byte positions.
  assert.equal(parseRange('bytes=1.5-2.5', SIZE), 'invalid');
  assert.equal(parseRange('bytes=1e3-', SIZE), 'invalid');
});

test('parseRange: unsatisfiable ranges are invalid (416 semantics)', () => {
  // start beyond the representation.
  assert.equal(parseRange('bytes=1000-', SIZE), 'invalid');
  assert.equal(parseRange('bytes=2000-3000', SIZE), 'invalid');
  // empty suffix.
  assert.equal(parseRange('bytes=-0', SIZE), 'invalid');
  assert.equal(parseRange('bytes=-0', 0), 'invalid');
  // end before start.
  assert.equal(parseRange('bytes=500-499', SIZE), 'invalid');
});

test('parseRange: empty representation (size 0) makes every range unsatisfiable', () => {
  assert.equal(parseRange('bytes=0-', 0), 'invalid');
  assert.equal(parseRange('bytes=-1', 0), 'invalid');
});

test('parseRange: suffix range on an empty file is unsatisfiable', () => {
  assert.equal(parseRange('bytes=-10', 0), 'invalid');
});

test('parseRange: leading-zero forms and exact boundaries stay valid', () => {
  assert.deepEqual(parseRange('bytes=00000000010-000000020', SIZE), { start: 10, end: 20 });
  assert.deepEqual(parseRange('bytes=999-', SIZE), { start: 999, end: 999 });
});
