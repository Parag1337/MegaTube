/**
 * Regression: undecodable codecs fail fast with an honest terminal reason.
 * The local ffmpeg build compiles h264/hevc/vc1/vvc decoders out; h264 is
 * served via libopenh264 but hevc/vc1/vvc have no decoder at all. Before the
 * fix, HEVC sources burned three attempts + MEGA bandwidth on a guaranteed
 * `output_invalid` failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UNDECODABLE_VIDEO_CODECS } from '@/lib/preview/ffmpeg';

test('undecodable codec set matches this host’s decoder situation', () => {
  for (const c of ['hevc', 'h265', 'vc1', 'vvc']) {
    assert.ok(UNDECODABLE_VIDEO_CODECS.has(c), `${c} must be classified unsupported`);
  }
  // h264 is decodable via libopenh264; AV1 via libdav1d — must NOT be blocked.
  for (const c of ['h264', 'av1', 'vp9', 'vp8', 'mpeg4', 'mpeg2video', 'theora', 'wmv3']) {
    assert.ok(!UNDECODABLE_VIDEO_CODECS.has(c), `${c} must not be blocked`);
  }
});
