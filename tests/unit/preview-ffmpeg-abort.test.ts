/**
 * Phase 5.1 remediation: external cancellation of a child process.
 *
 * The absolute job deadline and lease-loss path must terminate ffmpeg even
 * when it ignores SIGTERM. This uses a shell that ignores SIGTERM and execs
 * `sleep`, so only the SIGKILL escalation can finish it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess } from '@/lib/preview/ffmpeg';

test('runProcess: abort sends SIGTERM then escalates to SIGKILL', { timeout: 15_000 }, async () => {
  process.env.PREVIEW_PROCESS_KILL_GRACE_MS = '100';
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 100);
  const result = await runProcess(
    '/bin/sh',
    ['-c', 'trap "" TERM; exec sleep 10'],
    30_000,
    false,
    controller.signal,
  );
  const elapsed = Date.now() - started;
  assert.equal(result.aborted, true, 'reported as externally aborted');
  assert.equal(result.timedOut, false, 'not an invocation timeout');
  assert.equal(result.signal, 'SIGKILL', 'SIGTERM was ignored, so SIGKILL was required');
  assert.ok(elapsed < 5_000, `bounded abort took ${elapsed}ms`);
});

test('runProcess: a pre-aborted signal never spawns or hangs', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  const result = await runProcess('/bin/sh', ['-c', 'sleep 10'], 30_000, false, controller.signal);
  assert.equal(result.aborted, true);
  assert.equal(result.code, null);
  assert.ok(Date.now() - started < 500, 'returns immediately');
});
