/**
 * Phase 5 tests: bounded generation queue (lib/preview/queue.ts).
 * Single-flight dedupe, concurrency cap, queue cap, queued-job cancellation,
 * running-job completion. Pure in-memory — no fs, no ffmpeg.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let qMod: typeof import('@/lib/preview/queue');
let q: InstanceType<typeof import('@/lib/preview/queue')['PreviewQueue']>;

before(async () => {
  qMod = await import('@/lib/preview/queue');
});

beforeEach(() => {
  q = new qMod.PreviewQueue(1, 2);
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('running jobs are single-flight per key: second enqueue joins the promise', async () => {
  const gate = deferred<void>();
  const p1 = q.enqueue('hover:1', () => gate.promise);
  const p2 = q.enqueue('hover:1', () => gate.promise);
  assert.equal(q.snapshot().running, 1);
  gate.resolve();
  assert.equal(await p1, 'completed');
  assert.equal(await p2, 'completed', 'joined the same job');
  assert.equal(q.snapshot().running, 0);
});

test('queue-full rejects fast without starting work', async () => {
  const gate = deferred<void>();
  void q.enqueue('hover:1', () => gate.promise); // running
  void q.enqueue('hover:2', () => gate.promise); // queued 1
  void q.enqueue('hover:3', () => gate.promise); // queued 2
  await assert.rejects(q.enqueue('hover:4', () => gate.promise), qMod.QueueFullError);
  assert.equal(q.snapshot().queued, 2);
  assert.equal(q.snapshot().running, 1);
  gate.resolve();
});

test('queued jobs cancel on requester abort; running jobs complete', async () => {
  const gate = deferred<void>();
  const running = q.enqueue('hover:1', () => gate.promise); // occupies the slot
  const queued = q.enqueue('hover:2', () => gate.promise); // queued 1/2

  const abort1 = new AbortController();
  const cancellable = q.enqueue('hover:3', () => gate.promise, abort1.signal); // queued 2/2
  assert.equal(q.snapshot().queued, 2);
  abort1.abort();
  assert.equal(await cancellable, 'cancelled');
  assert.equal(q.snapshot().queued, 1, 'cancelled job left the queue');

  // The running and still-queued jobs are unaffected.
  gate.resolve();
  assert.equal(await running, 'completed');
  assert.equal(await queued, 'completed');
});

test('aborting before enqueue resolves cancelled immediately', async () => {
  const abort = new AbortController();
  abort.abort();
  const ran: string[] = [];
  const p = q.enqueue('hover:1', () => {
    ran.push('ran');
    return Promise.resolve();
  }, abort.signal);
  assert.equal(await p, 'cancelled');
  assert.deepEqual(ran, []);
});

test('runner failure resolves failed (not rejected) and frees the slot', async () => {
  const p = q.enqueue('hover:1', () => Promise.reject(new Error('boom')));
  assert.equal(await p, 'failed');
  assert.equal(q.snapshot().running, 0);
  // Slot freed: a new job can start right away.
  const p2 = q.enqueue('hover:1', () => Promise.resolve());
  assert.equal(await p2, 'completed');
});

test('FIFO order is preserved for queued jobs', async () => {
  const q2 = new qMod.PreviewQueue(1, 8);
  const order: string[] = [];
  const gate = deferred<void>();
  const runners = ['a', 'b', 'c', 'd'].map((k) => () => {
    order.push(k);
    return gate.promise;
  });
  const promises = runners.map((r, i) => q2.enqueue(`hover:${i}`, r));
  gate.resolve();
  await Promise.all(promises);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('after a queued cancellation the key can be re-enqueued', async () => {
  const gate = deferred<void>();
  void q.enqueue('hover:1', () => gate.promise); // running
  const abort = new AbortController();
  const first = q.enqueue('hover:2', () => gate.promise, abort.signal);
  abort.abort();
  assert.equal(await first, 'cancelled');
  assert.equal(q.has('hover:2'), false);
  const second = q.enqueue('hover:2', () => Promise.resolve());
  gate.resolve(); // free the slot so the re-enqueued job can run
  assert.equal(await second, 'completed', 're-enqueued after cancellation');
});

test('enqueueNow admits without waiting for the runner to finish', async () => {
  const gate = deferred<void>();
  let ran = false;
  const admission = q.enqueueNow('hover:1', () => {
    ran = true;
    return gate.promise;
  });
  assert.equal(admission, 'started');
  assert.equal(ran, true, 'runner started synchronously');
  assert.equal(q.snapshot().running, 1, 'job still running after admission returned');

  gate.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(q.snapshot().running, 0);
});

test('enqueueNow reports queued, joins single-flight, and rejects when full', async () => {
  const gate = deferred<void>();
  const running = q.enqueueNow('hover:1', () => gate.promise);
  assert.equal(running, 'started');
  assert.equal(q.enqueueNow('hover:1', () => gate.promise), 'started', 'joined running job');

  assert.equal(q.enqueueNow('hover:2', () => gate.promise), 'queued');
  assert.equal(q.enqueueNow('hover:2', () => Promise.resolve()), 'queued', 'joined queued job');
  assert.equal(q.enqueueNow('hover:3', () => gate.promise), 'queued');
  assert.equal(q.enqueueNow('hover:4', () => gate.promise), 'rejected', 'queue cap reached');
  assert.equal(q.snapshot().queued, 2);

  gate.resolve();
  await new Promise((r) => setImmediate(r));
});

test('enqueueNow runner failures are contained (no unhandled rejection)', async () => {
  assert.equal(q.enqueueNow('hover:1', () => Promise.reject(new Error('boom'))), 'started');
  await new Promise((r) => setImmediate(r));
  assert.equal(q.snapshot().running, 0);
  assert.equal(q.has('hover:1'), false);
});
