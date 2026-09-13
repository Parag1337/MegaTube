/**
 * P1.3 tests: bounded automatic recovery for retryable warming failures.
 *
 * The policy + state machine live in lib/player/retry.ts (framework-free),
 * so every behavior below runs with fake timers and mock probes — no DOM,
 * no waiting real seconds. The React component is a thin wiring layer over
 * WarmingRetryController (covered by browser verification + unchanged-code
 * review for autoplay/warm-cache paths).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUTO_RETRIES,
  UNAVAILABLE_MESSAGE,
  WarmingRetryController,
  backoffForAttemptMs,
  decideRetry,
  parseRetryAfterMs,
  type EndpointProbeResult,
  type WarmingRetryCallbacks,
} from '@/lib/player/retry';

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------
test('parseRetryAfterMs: seconds honored, clamped, garbage rejected', () => {
  assert.equal(parseRetryAfterMs('5'), 5000);
  assert.equal(parseRetryAfterMs('0'), 1000, 'clamped to the 1s floor');
  assert.equal(parseRetryAfterMs('999'), 30000, 'clamped to the 30s ceiling');
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs('soon'), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs('Mon, 01 Jan 2030 00:00:00 GMT'), null, 'HTTP-date form unsupported by design');
});

test('backoffForAttemptMs: 1s -> 2s -> 4s, capped', () => {
  assert.deepEqual([backoffForAttemptMs(0), backoffForAttemptMs(1), backoffForAttemptMs(2)], [1000, 2000, 4000]);
  assert.equal(backoffForAttemptMs(99), 4000, 'capped, never grows');
  assert.equal(backoffForAttemptMs(-1), 1000, 'negative guarded');
});

test('decideRetry: status matrix', () => {
  assert.deepEqual(decideRetry({ status: 503, retryAfter: '5' }, 0), { action: 'retry', delayMs: 5000 });
  assert.deepEqual(decideRetry({ status: 503, retryAfter: null }, 1), { action: 'retry', delayMs: 2000 });
  assert.deepEqual(decideRetry({ status: 503, retryAfter: 'bogus' }, 0), { action: 'retry', delayMs: 1000 });
  assert.deepEqual(decideRetry({ status: 429, retryAfter: '2' }, 0), { action: 'retry', delayMs: 2000 });
  assert.deepEqual(decideRetry({ status: 500, retryAfter: null }, 0), { action: 'retry', delayMs: 1000 });
  assert.deepEqual(decideRetry({ status: 502, retryAfter: null }, 2), { action: 'retry', delayMs: 4000 });
  assert.deepEqual(decideRetry({ status: 200, retryAfter: null }, 0), { action: 'retry', delayMs: 1000 }, 'healthy endpoint + torn stream = short-fuse retry');
  assert.deepEqual(decideRetry({ status: 206, retryAfter: null }, 0), { action: 'retry', delayMs: 1000 });
  assert.deepEqual(decideRetry({ status: 410, retryAfter: null }, 0), { action: 'unavailable' });
  assert.deepEqual(decideRetry({ status: 404, retryAfter: null }, 0).action, 'fatal');
  assert.deepEqual(decideRetry({ status: 401, retryAfter: null }, 0).action, 'fatal');
  assert.deepEqual(decideRetry({ status: 416, retryAfter: null }, 0).action, 'fatal');
  assert.deepEqual(decideRetry({ fetchFailed: true }, 1), { action: 'retry', delayMs: 2000 }, 'unreachable endpoint uses backoff');
  assert.equal(decideRetry(null, 0).action, 'fatal', 'no probe data is never retryable');
});

// ---------------------------------------------------------------------------
// Controller harness (fake clock + mock probe)
// ---------------------------------------------------------------------------
interface Harness {
  ctrl: WarmingRetryController;
  clock: {
    pending: () => number;
    fireAll: () => void;
    delays: number[];
  };
  events: Array<{ type: string; attempt?: number; delayMs?: number; resumeTime?: number | null; kind?: string; message?: string }>;
  probes: number;
  resolveProbe: (r: EndpointProbeResult) => void;
  rejectProbe: (e: unknown) => void;
}

function makeHarness(
  probeImpl?: (signal: AbortSignal) => Promise<EndpointProbeResult>,
  maxAttempts = MAX_AUTO_RETRIES,
): Harness {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const delays: number[] = [];
  const events: Harness['events'] = [];
  let probes = 0;
  let resolveProbe: (r: EndpointProbeResult) => void = () => {};
  let rejectProbe: (e: unknown) => void = () => {};
  const pendingProbe = new Promise<EndpointProbeResult>((res, rej) => {
    resolveProbe = res;
    rejectProbe = rej;
  });
  const ctrl = new WarmingRetryController(
    (signal) => {
      probes++;
      return probeImpl ? probeImpl(signal) : pendingProbe;
    },
    {
      onPreparing: (attempt, delayMs) => events.push({ type: 'preparing', attempt, delayMs }),
      onRetry: (attempt, resumeTime) => events.push({ type: 'retry', attempt, resumeTime }),
      onExhausted: (kind, message) => events.push({ type: 'exhausted', kind, message }),
    } as WarmingRetryCallbacks,
    maxAttempts,
    {
      setTimeout: (fn, ms) => {
        delays.push(ms);
        const id = nextId++;
        timers.set(id, fn);
        return id;
      },
      clearTimeout: (h) => {
        timers.delete(h as number);
      },
    },
  );
  return {
    ctrl,
    clock: {
      pending: () => timers.size,
      fireAll: () => {
        const fns = [...timers.values()];
        timers.clear();
        fns.forEach((f) => f());
      },
      delays,
    },
    events,
    get probes() {
      return probes;
    },
    resolveProbe,
    rejectProbe,
  };
}

async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

test('P1.3.1: retryable 503 triggers one automatic retry honoring Retry-After', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '5' }));
  h.ctrl.handleError(2, null);
  await tick();
  assert.equal(h.probes, 1, 'endpoint probed once per episode');
  assert.deepEqual(h.events, [{ type: 'preparing', attempt: 1, delayMs: 5000 }]);
  assert.deepEqual(h.clock.delays, [5000], 'Retry-After: 5 respected, no hammering');
  h.clock.fireAll();
  assert.deepEqual(h.events[1], { type: 'retry', attempt: 1, resumeTime: null });
  assert.equal(h.ctrl.attempts, 1);
});

test('P1.3.3/4/13: multiple 503s retry bounded, then stop — no loop', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '5' }));
  for (let i = 0; i < 10; i++) {
    h.ctrl.handleError(2, null);
    await tick();
    h.clock.fireAll();
    await tick();
  }
  const retries = h.events.filter((e) => e.type === 'retry');
  const exhausted = h.events.filter((e) => e.type === 'exhausted');
  assert.equal(retries.length, MAX_AUTO_RETRIES, `exactly ${MAX_AUTO_RETRIES} automatic retries total`);
  assert.deepEqual(retries.map((e) => e.attempt), [1, 2, 3]);
  assert.ok(exhausted.length >= 1, 'terminal panel announced (re-announced per later error, same state)');
  assert.equal(h.probes, MAX_AUTO_RETRIES, 'no probe after the budget is spent');
  assert.equal(h.clock.pending(), 0, 'no dangling timer');
});

test('P1.3.5: manual Retry resets the budget', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '1' }));
  for (let i = 0; i < MAX_AUTO_RETRIES; i++) {
    h.ctrl.handleError(2, null);
    await tick();
    h.clock.fireAll();
    await tick();
  }
  assert.equal(h.ctrl.attempts, MAX_AUTO_RETRIES);
  h.ctrl.handleError(2, null);
  await tick();
  assert.equal(h.events.filter((e) => e.type === 'exhausted').length, 1, 'budget spent');
  h.ctrl.manualRetry();
  assert.equal(h.ctrl.attempts, 0, 'manual action resets the budget');
  h.ctrl.handleError(2, null);
  await tick();
  assert.equal(h.probes, MAX_AUTO_RETRIES + 1, 'a fresh attempt probes again');
  h.clock.fireAll();
  assert.deepEqual(h.events.at(-1), { type: 'retry', attempt: 1, resumeTime: null });
});

test('P1.3.6: 410 never auto-retries (unavailable panel)', async () => {
  const h = makeHarness(async () => ({ status: 410, retryAfter: null }));
  h.ctrl.handleError(4, null);
  await tick();
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].type, 'exhausted');
  assert.equal(h.events[0].kind, 'unavailable');
  assert.equal(h.events[0].message, UNAVAILABLE_MESSAGE);
  assert.equal(h.clock.pending(), 0, 'no timer scheduled');
  assert.equal(h.ctrl.attempts, 0, '410 consumes no budget');
});

test('P1.3.7: permanent 4xx (and decode error + 404 probe) never auto-retries', async () => {
  for (const code of [2, 3, 4, undefined]) {
    const h = makeHarness(async () => ({ status: 404, retryAfter: null }));
    h.ctrl.handleError(code, null);
    await tick();
    assert.equal(h.events.length, 1, `code ${String(code)}: single terminal event`);
    assert.equal(h.events[0].type, 'exhausted');
    assert.equal(h.clock.pending(), 0, `code ${String(code)}: no timer`);
  }
});

test('P1.3.8: user aborts never probe, never retry, never panel', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '5' }));
  h.ctrl.handleError(1, 300);
  await tick(10);
  assert.equal(h.probes, 0, 'abort is never probed');
  assert.equal(h.events.length, 0, 'abort produces no UI change at all');
  assert.equal(h.ctrl.pendingSeek, null, 'abort stores no seek target');
});

test('P1.3.9/10: unmount and video change cancel pending timers and probes', async () => {
  // Pending timer cancelled.
  const h = makeHarness(async () => ({ status: 503, retryAfter: '5' }));
  h.ctrl.handleError(2, null);
  await tick();
  assert.equal(h.clock.pending(), 1);
  h.ctrl.cancel();
  h.clock.fireAll();
  assert.ok(!h.events.some((e) => e.type === 'retry'), 'cancelled timer never remounts');
  // In-flight probe aborted + ignored when it settles late.
  let aborted = false;
  const h2 = makeHarness((signal) => new Promise<EndpointProbeResult>((_, rej) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  }));
  h2.ctrl.handleError(2, null);
  await tick();
  h2.ctrl.cancel();
  await tick(10);
  assert.ok(aborted, 'probe fetch aborted on cancel');
  assert.equal(h2.events.length, 0, 'late probe settlement ignored after cancel');
  // Controller reusable after cancel (video change = fresh instance in practice).
  h2.ctrl.handleError(2, null);
  await tick();
  assert.equal(h2.probes, 2, 'works again after cancel');
});

test('P1.3.11: seek target preserved across retry (and ignored when meaningless)', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '1' }));
  h.ctrl.handleError(2, 300);
  await tick();
  h.clock.fireAll();
  assert.deepEqual(h.events.at(-1), { type: 'retry', attempt: 1, resumeTime: 300 }, 'user at 10s seeking to 300s resumes near 300s');

  const h2 = makeHarness(async () => ({ status: 503, retryAfter: '1' }));
  h2.ctrl.handleError(2, 0.4);
  await tick();
  h2.clock.fireAll();
  assert.deepEqual(h2.events.at(-1)?.resumeTime, null, 'sub-second position is not a seek target');

  const h3 = makeHarness(async () => ({ status: 503, retryAfter: '1' }));
  h3.ctrl.handleError(2, null);
  await tick();
  h3.clock.fireAll();
  assert.deepEqual(h3.events.at(-1)?.resumeTime, null, 'unknown position stays a start-0 retry');
});

test('P1.3.12: successful playback resets retry state', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '1' }));
  for (let i = 0; i < 2; i++) {
    h.ctrl.handleError(2, 120);
    await tick();
    h.clock.fireAll();
    await tick();
  }
  assert.equal(h.ctrl.attempts, 2);
  assert.equal(h.ctrl.pendingSeek, 120);
  h.ctrl.notifyPlaying();
  assert.equal(h.ctrl.attempts, 0, 'budget restored');
  assert.equal(h.ctrl.pendingSeek, null, 'saved target cleared');
  h.ctrl.handleError(2, null);
  await tick();
  h.clock.fireAll();
  assert.deepEqual(h.events.at(-1), { type: 'retry', attempt: 1, resumeTime: null }, 'next failure starts a fresh budget');
});

test('P1.3: concurrent errors during a probe episode share it (no double probe)', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '1' }));
  h.ctrl.handleError(2, null);
  h.ctrl.handleError(2, null);
  h.ctrl.handleError(4, null);
  await tick();
  assert.equal(h.probes, 1, 'one probe per episode regardless of error burst');
  assert.equal(h.events.filter((e) => e.type === 'preparing').length, 1);
});

test('P1.3: retryNow fires a pending retry immediately and consumes budget', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '30' }));
  h.ctrl.handleError(2, 45);
  await tick();
  assert.equal(h.clock.pending(), 1, 'waiting out the long Retry-After');
  h.ctrl.retryNow();
  assert.equal(h.clock.pending(), 0, 'timer consumed');
  assert.deepEqual(h.events.at(-1), { type: 'retry', attempt: 1, resumeTime: 45 });
  h.ctrl.retryNow();
  assert.equal(h.events.filter((e) => e.type === 'retry').length, 1, 'idle retryNow is a no-op');
});

test('P1.3: probe rejection (non-abort) degrades to bounded backoff, not a crash', async () => {
  const h = makeHarness(async () => {
    throw new Error('probe transport blew up');
  });
  h.ctrl.handleError(2, null);
  await tick();
  assert.deepEqual(h.events, [{ type: 'preparing', attempt: 1, delayMs: 1000 }]);
  h.clock.fireAll();
  assert.equal(h.events.at(-1)?.type, 'retry');
});

test('P1.3: success during a pending probe drops the late decision (never remounts healthy playback)', async () => {
  let release!: (r: EndpointProbeResult) => void;
  const h = makeHarness(() => new Promise<EndpointProbeResult>((res) => {
    release = res;
  }));
  h.ctrl.handleError(2, null);
  await tick();
  assert.equal(h.probes, 1);
  h.ctrl.notifyPlaying();
  release({ status: 503, retryAfter: '1' });
  await tick(10);
  assert.equal(h.events.length, 0, 'late probe outcome ignored after success');
  assert.equal(h.clock.pending(), 0, 'no timer scheduled');
});

test('P1.3: success with a scheduled retry pending prevents the remount', async () => {
  const h = makeHarness(async () => ({ status: 503, retryAfter: '30' }));
  h.ctrl.handleError(2, null);
  await tick();
  assert.equal(h.clock.pending(), 1, 'retry scheduled');
  h.ctrl.notifyPlaying();
  assert.equal(h.clock.pending(), 0, 'pending retry cancelled by success');
  h.clock.fireAll();
  assert.ok(!h.events.some((e) => e.type === 'retry'), 'no remount after success');
});
