/**
 * Phase 5.1: multi-scene montage planning.
 *
 * These pin the scene-selection rules that make card previews representative:
 * scenes spread across the whole video, no duplicate/near-identical starts,
 * graceful short-video handling, bounded landscape/portrait canvases that
 * never upscale, an fps cap that never up-converts, and merged MEGA ranges.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeByteWindows,
  montageCanvas,
  outputFps,
  planMontage,
  sceneAlternatives,
} from '@/lib/preview/segment';

const CAPS = {
  maxWidthLandscape: 640,
  maxHeightLandscape: 360,
  maxWidthPortrait: 360,
  maxHeightPortrait: 640,
};

test('planMontage: five scenes span roughly 10%–90% of a 20-minute video', () => {
  const plan = planMontage(1200, 5, 1.2);
  assert.equal(plan.scenes.length, 5);
  const targets = plan.scenes.map((s) => s.targetSec);
  assert.ok(targets[0] >= 100 && targets[0] <= 140, `first target ${targets[0]}`);
  assert.ok(targets[4] >= 1060 && targets[4] <= 1100, `last target ${targets[4]}`);
  for (let i = 1; i < targets.length; i++) {
    assert.ok(targets[i] > targets[i - 1], 'targets increase across the video');
  }
  const total = plan.scenes.reduce((sum, s) => sum + s.durationSec, 0);
  assert.ok(total >= 5 && total <= 7, `montage length ${total}s`);
});

test('planMontage: no duplicate or near-identical scene starts', () => {
  for (const duration of [8, 12, 30, 300, 7200]) {
    const plan = planMontage(duration, 5, 1.2);
    for (let i = 0; i < plan.scenes.length; i++) {
      for (let j = i + 1; j < plan.scenes.length; j++) {
        const gap = Math.abs(plan.scenes[i].startSec - plan.scenes[j].startSec);
        assert.ok(gap >= 0.4, `duration ${duration}: scenes ${i}/${j} too close (${gap}s)`);
      }
    }
  }
});

test('planMontage: short videos use fewer/shorter scenes and never exceed the source', () => {
  const plan = planMontage(2.5, 5, 1.2);
  assert.ok(plan.scenes.length >= 1 && plan.scenes.length <= 2, 'few scenes');
  for (const scene of plan.scenes) {
    assert.ok(scene.startSec + scene.durationSec <= 2.5 + 0.001, 'stays inside the source');
    assert.ok(scene.durationSec > 0);
  }
  assert.ok(plan.totalSeconds <= 2.5 + 0.001);
});

test('planMontage: unknown duration uses the estimated ladder and flags it', () => {
  const plan = planMontage(null, 5, 1.2);
  assert.equal(plan.estimated, true);
  assert.deepEqual(
    plan.scenes.map((s) => s.targetSec),
    [10, 30, 50, 70, 90],
  );
  assert.ok(plan.scenes.every((s) => s.estimated));
  assert.deepEqual(
    plan.scenes.map((s) => s.fraction),
    [0.1, 0.3, 0.5, 0.7, 0.9],
    'unknown-duration scenes carry an explicit file fraction',
  );
});

test('planMontage: known-duration scenes carry exact fractions and are not estimated', () => {
  const plan = planMontage(600, 5, 1.2);
  assert.equal(plan.estimated, false);
  assert.ok(plan.scenes.every((s) => !s.estimated));
  for (const scene of plan.scenes) {
    assert.ok(scene.fraction !== null);
    assert.ok(scene.fraction! >= 0 && scene.fraction! <= 1);
    assert.ok(Math.abs(scene.fraction! - scene.startSec / 600) < 1e-9);
  }
});

test('planMontage: a 1-scene request keeps a centered scene', () => {
  const plan = planMontage(600, 1, 1.2);
  assert.equal(plan.scenes.length, 1);
  assert.ok(plan.scenes[0].targetSec > 250 && plan.scenes[0].targetSec < 350);
});

test('sceneAlternatives: bounded offsets, unique, clamped to the source', () => {
  const plan = planMontage(1200, 5, 1.2);
  const alts = sceneAlternatives(plan.scenes[0], 1200, 2);
  assert.equal(alts.length, 3);
  assert.equal(new Set(alts.map((a) => a.toFixed(2))).size, alts.length);
  assert.ok(alts.every((a) => a >= 0 && a <= 1200 - plan.scenes[0].durationSec));
  // The original position is always tried first.
  assert.equal(alts[0], plan.scenes[0].startSec);
});

test('montageCanvas: landscape capped at 640×360, aspect preserved', () => {
  const canvas = montageCanvas(1920, 1080, CAPS);
  assert.equal(canvas.width, 640);
  assert.equal(canvas.height, 360);
});

test('montageCanvas: portrait capped at 360×640, never cropped', () => {
  const canvas = montageCanvas(1080, 1920, CAPS);
  assert.equal(canvas.width, 360);
  assert.equal(canvas.height, 640);
});

test('montageCanvas: low-resolution sources are never upscaled', () => {
  const canvas = montageCanvas(320, 180, CAPS);
  assert.equal(canvas.width, 320);
  assert.equal(canvas.height, 180);
  const tiny = montageCanvas(200, 400, CAPS);
  assert.equal(tiny.width, 200);
  assert.equal(tiny.height, 400);
});

test('montageCanvas: output dimensions are even (yuv420p requirement)', () => {
  for (const [w, h] of [
    [1919, 1079],
    [721, 405],
    [853, 479],
    [1081, 1921],
  ]) {
    const canvas = montageCanvas(w, h, CAPS);
    assert.equal(canvas.width % 2, 0, `${w}x${h} width`);
    assert.equal(canvas.height % 2, 0, `${w}x${h} height`);
  }
});

test('outputFps: caps high frame rates and never up-converts low ones', () => {
  assert.equal(outputFps(60, 24), 24);
  assert.equal(outputFps(23.976, 24), 23, 'NTSC fps must not become 24');
  assert.equal(outputFps(15, 24), 15);
  assert.equal(outputFps(12.5, 24), 12);
  assert.equal(outputFps(null, 24), 24);
  assert.equal(outputFps(0, 24), 24);
});

test('mergeByteWindows: nearby windows become one range request', () => {
  const merged = mergeByteWindows(
    [
      { byteStart: 0, byteLen: 1000 },
      { byteStart: 1200, byteLen: 1000 },
      { byteStart: 5000, byteLen: 1000 },
    ],
    10_000,
    500,
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], { byteStart: 0, byteLen: 2200 });
});

test('mergeByteWindows: gaps beyond the limit stay separate; caps are respected', () => {
  const merged = mergeByteWindows(
    [
      { byteStart: 0, byteLen: 1000 },
      { byteStart: 5000, byteLen: 1000 },
      { byteStart: 5200, byteLen: 1000 },
    ],
    1500,
    500,
  );
  // The two close windows merge (1200 B ≤ 1500 B cap); the far one stays.
  assert.equal(merged.length, 2, 'per-range byte cap still bounds each merge');
  assert.deepEqual(merged[0], { byteStart: 0, byteLen: 1000 });
  assert.deepEqual(merged[1], { byteStart: 5000, byteLen: 1200 });

  const far = mergeByteWindows(
    [
      { byteStart: 0, byteLen: 1000 },
      { byteStart: 10_000, byteLen: 1000 },
    ],
    100_000,
    500,
  );
  assert.equal(far.length, 2);
});
