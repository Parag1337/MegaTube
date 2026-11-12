/**
 * Phase 5.1 remediation: REAL ffmpeg reproduction of montage argument order.
 *
 * The audit questioned whether per-input `-ss`/`-t` placed before `-i` really
 * select the intended source ranges. This test builds a synthetic video with
 * three solid-colour 4 s segments (red → green → blue), extracts one second
 * from the middle of each with `encodeMontage()`, and samples the resulting
 * montage. If the option placement were wrong, the montage would not be
 * red → green → blue in order.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeMontage, ffmpegPath, runFfmpeg, validateMontageFile } from '@/lib/preview/ffmpeg';

const hasFfmpeg = (() => {
  try {
    return spawnSync(ffmpegPath(), ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

/** Decode one tiny RGB frame at `t` and return its average channel values. */
async function sampleRgb(file: string, t: number): Promise<{ r: number; g: number; b: number }> {
  const run = await runFfmpeg(
    [
      '-ss', t.toFixed(3),
      '-i', file,
      '-frames:v', '1',
      '-vf', 'scale=1:1',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-',
    ],
    30_000,
    true,
  );
  assert.equal(run.code, 0, `frame sample at ${t}s: ${run.stderrTail}`);
  assert.ok(run.stdout && run.stdout.length >= 3, 'rgb frame bytes');
  return { r: run.stdout[0], g: run.stdout[1], b: run.stdout[2] };
}

test(
  'encodeMontage: per-input -ss/-t select the intended scenes in order (real ffmpeg)',
  { skip: hasFfmpeg ? false : 'ffmpeg not installed', timeout: 120_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'megatube-montage-repro-'));
    try {
      const source = path.join(dir, 'source.mp4');
      const fixture = await runFfmpeg(
        [
          '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=4:r=24',
          '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=4:r=24',
          '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=4:r=24',
          '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
          '-map', '[outv]',
          '-c:v', 'libopenh264',
          '-pix_fmt', 'yuv420p',
          '-b:v', '800k',
          '-rc_mode', 'bitrate',
          '-r', '24',
          '-movflags', '+faststart',
          '-f', 'mp4',
          '-y', source,
        ],
        60_000,
      );
      assert.equal(fixture.code, 0, `fixture encode failed: ${fixture.stderrTail}`);

      const out = path.join(dir, 'montage.mp4');
      const encoded = await encodeMontage({
        inputs: [
          { path: source, seekSec: 2, durationSec: 1 },
          { path: source, seekSec: 6, durationSec: 1 },
          { path: source, seekSec: 10, durationSec: 1 },
        ],
        width: 320,
        height: 180,
        fps: 24,
        bitrateKbps: 500,
        outPath: out,
        timeoutMs: 60_000,
      });
      assert.equal(encoded.ok, true, encoded.detail);

      const validation = await validateMontageFile(out, {
        minDurationSec: 1.5,
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 30_000,
      });
      assert.equal(validation.ok, true, validation.ok ? '' : validation.reason);
      assert.ok((validation.durationSec ?? 0) >= 2.5, `montage duration ${validation.durationSec}`);

      // Scene order is chronological: red, then green, then blue.
      const first = await sampleRgb(out, 0.5);
      const second = await sampleRgb(out, 1.5);
      const third = await sampleRgb(out, 2.5);
      assert.ok(first.r > 150 && first.g < 100 && first.b < 100, `first scene red: ${JSON.stringify(first)}`);
      // ffmpeg's named "green" is 0x008000, so its channel is ~128.
      assert.ok(second.g > 100 && second.r < 60 && second.b < 60, `second scene green: ${JSON.stringify(second)}`);
      assert.ok(third.b > 150 && third.r < 100 && third.g < 120, `third scene blue: ${JSON.stringify(third)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
