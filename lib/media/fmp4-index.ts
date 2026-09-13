/**
 * Fragment-level index for live fMP4 spools (Phase 2: future-timeline seekability).
 *
 * Purpose: resolve a playback TIME to a SAFE spool byte boundary (start of a
 * complete moof+mdat fragment) without ever guessing from bitrate or confusing
 * source-TS bytes with fMP4 output bytes.
 *
 * Observed ffmpeg output (`-movflags frag_keyframe+empty_moov+default_base_moof`):
 *   ftyp, moov (with trak/mdia/mdhd per-track timescales), then repeating
 *   moof (mfhd + one traf per track: tfhd w/ track_ID, tfdt w/ base decode
 *   time, trun) + mdat pairs. Verified empirically Sept 2026 (see parser
 *   tests): video track tfdt/timescale gives fragment start time.
 *
 * Completion gating: a fragment enters the index ONLY after its full moof AND
 * its full following mdat are present. The parser consumes bytes strictly in
 * spool order and never emits a fragment from a partial moof/mdat.
 *
 * Resolution policy (documented choice):
 * - time -> nearest fragment with startTime <= t ("at or before"). A request
 *   between two fragments serves the earlier one (browser decodes forward to
 *   the target; serving the later one would skip content).
 * - time before the first fragment -> null (caller serves from the start or
 *   waits/fails; never fabricate).
 * - time after the current frontier -> null (caller waits bounded for growth).
 * - byte -> fragment containing the byte, else nearest fragment starting at
 *   or before the byte (snap BACK to safety; never forward into unknown).
 *
 * In-memory only by design: the index lives and dies with its LiveRemuxJob
 * and spool file. A restarted job truncates the spool and builds a fresh
 * index, so stale entries can never be served. No disk sidecar, no orphan
 * handling needed.
 */

export interface Fmp4Fragment {
  /** 0-based order in the spool. */
  index: number;
  /** Fragment start time in seconds (min across trafs; video traf preferred). */
  startTime: number;
  /** Spool offset where the moof starts (safe seek boundary). */
  spoolOffset: number;
  /** Spool offset one past the end of the mdat (exclusive). */
  endOffset: number;
  /** Total fragment size in bytes (moof + mdat). */
  size: number;
  /** mfhd sequence number when present, else null. */
  sequence: number | null;
}

export interface Fmp4Indexer {
  /** track_ID -> mdhd timescale (parsed from init). */
  timescaleByTrack: Map<number, number>;
  /** Track ID treated as video (first trak), used to prefer its tfdt. */
  videoTrackId: number | null;
  /** True once init timescales were set. */
  initReady: boolean;
  /** Spool offset that pending[0] corresponds to. */
  parseOffset: number;
  /** Unconsumed tail bytes (incomplete box held for more data). */
  pending: Buffer;
  /** Completed fragments in spool order. */
  fragments: Fmp4Fragment[];
}

export function createFmp4Indexer(): Fmp4Indexer {
  return {
    timescaleByTrack: new Map(),
    videoTrackId: null,
    initReady: false,
    parseOffset: 0,
    pending: Buffer.alloc(0),
    fragments: [],
  };
}

interface BoxHeader {
  size: number;
  type: string;
  headerLen: number;
}

/** Read an ISO-BMFF box header at `off`. Null when fewer than 8 bytes. */
function readBoxHeader(buf: Buffer, off: number): BoxHeader | null {
  if (off + 8 > buf.length) return null;
  const size32 = buf.readUInt32BE(off);
  const type = buf.toString('latin1', off + 4, off + 8);
  if (size32 === 1) {
    if (off + 16 > buf.length) return null;
    const hi = buf.readUInt32BE(off + 8);
    const lo = buf.readUInt32BE(off + 12);
    const size = hi * 2 ** 32 + lo;
    if (!Number.isSafeInteger(size) || size < 16) return null;
    return { size, type, headerLen: 16 };
  }
  if (size32 === 0) {
    // size 0 = to end of file: only meaningful for a durable extent; treat
    // the rest of the buffer as the box (callers hold incomplete tails, so
    // this only fires on complete data).
    return { size: buf.length - off, type, headerLen: 8 };
  }
  if (size32 < 8) return null;
  return { size: size32, type, headerLen: 8 };
}

function childBoxes(buf: Buffer, start: number, end: number): Array<{ off: number; size: number; type: string; headerLen: number }> {
  const out: Array<{ off: number; size: number; type: string; headerLen: number }> = [];
  let off = start;
  while (off + 8 <= end) {
    const h = readBoxHeader(buf, off);
    if (!h || h.size < 8 || off + h.size > end) break;
    out.push({ off, size: h.size, type: h.type, headerLen: h.headerLen });
    off += h.size;
  }
  return out;
}

/**
 * Parse per-track timescales from an fMP4 init segment (ftyp+moov).
 * Returns the track map + the first trak's ID as the video preference.
 * Empty map when the init has no usable moov/trak/mdhd (caller then cannot
 * index by time and must fall back to byte-continuity behavior).
 */
export function parseTrackTimescales(init: Buffer): { byTrack: Map<number, number>; videoTrackId: number | null } {
  const byTrack = new Map<number, number>();
  let videoTrackId: number | null = null;
  try {
    // Top-level scan for moov.
    let moovOff = -1;
    let moovSize = 0;
    let off = 0;
    while (off + 8 <= init.length) {
      const h = readBoxHeader(init, off);
      if (!h || h.size < 8 || off + h.size > init.length) break;
      if (h.type === 'moov') {
        moovOff = off;
        moovSize = h.size;
        break;
      }
      off += h.size;
    }
    if (moovOff < 0) return { byTrack, videoTrackId };
    for (const trak of childBoxes(init, moovOff + 8, moovOff + moovSize).filter((b) => b.type === 'trak')) {
      let trackId: number | null = null;
      let timescale: number | null = null;
      for (const child of childBoxes(init, trak.off + 8, trak.off + trak.size)) {
        if (child.type === 'tkhd') {
          const version = init[child.off + 8];
          const idOff = version === 1 ? child.off + 28 : child.off + 20;
          if (idOff + 4 <= init.length && idOff + 4 <= trak.off + trak.size) {
            trackId = init.readUInt32BE(idOff);
          }
        } else if (child.type === 'mdia') {
          for (const mdiaChild of childBoxes(init, child.off + 8, child.off + child.size)) {
            if (mdiaChild.type !== 'mdhd') continue;
            const version = init[mdiaChild.off + 8];
            const tsOff = version === 1 ? mdiaChild.off + 28 : mdiaChild.off + 20;
            if (tsOff + 4 <= init.length && tsOff + 4 <= mdiaChild.off + mdiaChild.size) {
              const ts = init.readUInt32BE(tsOff);
              if (Number.isFinite(ts) && ts > 0) timescale = ts;
            }
          }
        }
      }
      if (trackId !== null && timescale !== null) {
        byTrack.set(trackId, timescale);
        if (videoTrackId === null) videoTrackId = trackId;
      }
    }
  } catch {
    // Parse failure -> empty map (fail-closed: no time indexing).
  }
  return { byTrack, videoTrackId };
}

/**
 * Point the indexer at a published init segment. `initSpoolLength` is the
 * spool offset where post-init bytes begin (normally init.length, since the
 * spool starts at 0 with the init). Resets all fragment state.
 */
export function setIndexerInit(indexer: Fmp4Indexer, init: Buffer, initSpoolLength: number): void {
  const { byTrack, videoTrackId } = parseTrackTimescales(init);
  indexer.timescaleByTrack = byTrack;
  indexer.videoTrackId = videoTrackId;
  indexer.initReady = byTrack.size > 0;
  indexer.parseOffset = initSpoolLength;
  indexer.pending = Buffer.alloc(0);
  indexer.fragments = [];
}

/** Extract (trackId, baseDecodeTime) pairs from a complete moof buffer. */
function extractTrafTimes(moof: Buffer): Array<{ trackId: number; base: number }> {
  const out: Array<{ trackId: number; base: number }> = [];
  for (const traf of childBoxes(moof, 8, moof.length).filter((b) => b.type === 'traf')) {
    let trackId: number | null = null;
    let base: number | null = null;
    for (const child of childBoxes(moof, traf.off + 8, traf.off + traf.size)) {
      if (child.type === 'tfhd') {
        // tfhd: version/flags(4) then track_ID(4). Flags may add optional
        // fields AFTER track_ID, so track_ID is always at +12.
        if (child.off + 16 <= moof.length) trackId = moof.readUInt32BE(child.off + 12);
      } else if (child.type === 'tfdt') {
        const version = moof[child.off + 8];
        if (version === 1) {
          if (child.off + 20 <= moof.length) {
            const hi = moof.readUInt32BE(child.off + 12);
            const lo = moof.readUInt32BE(child.off + 16);
            const v = hi * 2 ** 32 + lo;
            if (Number.isSafeInteger(v)) base = v;
          }
        } else {
          if (child.off + 16 <= moof.length) base = moof.readUInt32BE(child.off + 12);
        }
      }
    }
    if (trackId !== null && base !== null) out.push({ trackId, base });
  }
  return out;
}

function extractSequence(moof: Buffer): number | null {
  for (const child of childBoxes(moof, 8, moof.length)) {
    if (child.type !== 'mfhd') continue;
    if (child.off + 16 <= moof.length) return moof.readUInt32BE(child.off + 12);
    return null;
  }
  return null;
}

/**
 * Feed newly durable spool bytes into the indexer.
 *
 * `chunkSpoolOffset` is the spool offset of chunk[0]; chunks must arrive in
 * spool order (the spoolSynced chain guarantees this). Gaps/overlaps are
 * handled defensively: overlaps are trimmed, gaps reset the tail parser so a
 * misaligned parse can never emit a false boundary.
 *
 * Returns newly completed fragments (moof+mdat both fully present).
 */
export function appendSpoolBytes(
  indexer: Fmp4Indexer,
  chunk: Buffer,
  chunkSpoolOffset: number,
): Fmp4Fragment[] {
  const emitted: Fmp4Fragment[] = [];
  if (chunk.length === 0) return emitted;
  const expected = indexer.parseOffset + indexer.pending.length;
  let payload = chunk;
  if (chunkSpoolOffset < expected) {
    const skip = expected - chunkSpoolOffset;
    if (skip >= chunk.length) return emitted; // full duplicate
    payload = chunk.subarray(skip);
  } else if (chunkSpoolOffset > expected) {
    // Gap (should not happen via the ordered chain): drop the tail so a
    // boundary is never computed across missing bytes.
    indexer.pending = Buffer.alloc(0);
    indexer.parseOffset = chunkSpoolOffset;
  }
  indexer.pending = indexer.pending.length > 0 ? Buffer.concat([indexer.pending, payload]) : Buffer.from(payload);

  for (;;) {
    const h = readBoxHeader(indexer.pending, 0);
    if (!h) break; // need header bytes
    if (h.size < 8) {
      // Corrupt size: drop one byte and resync rather than stalling forever.
      indexer.pending = indexer.pending.subarray(1);
      indexer.parseOffset += 1;
      continue;
    }
    if (indexer.pending.length < h.size) break; // incomplete box: wait
    if (h.type === 'moof') {
      // Need the following mdat to be fully present before emitting.
      const moofBuf = indexer.pending.subarray(0, h.size);
      const h2 = readBoxHeader(indexer.pending, h.size);
      if (!h2) break; // need mdat header
      if (h2.size < 8) {
        indexer.pending = indexer.pending.subarray(1);
        indexer.parseOffset += 1;
        continue;
      }
      if (indexer.pending.length < h.size + h2.size) break; // partial mdat
      if (h2.type !== 'mdat') {
        // Unexpected box between moof and mdat (e.g. sidx/moof): consume the
        // moof alone WITHOUT emitting (no media data proven present).
        indexer.pending = indexer.pending.subarray(h.size);
        indexer.parseOffset += h.size;
        void moofBuf;
        continue;
      }
      const fragStart = indexer.parseOffset;
      const fragEnd = indexer.parseOffset + h.size + h2.size;
      const times = extractTrafTimes(moofBuf);
      let startTime: number | null = null;
      if (indexer.initReady) {
        let videoT: number | null = null;
        let minT: number | null = null;
        for (const t of times) {
          const ts = indexer.timescaleByTrack.get(t.trackId);
          if (!ts || ts <= 0) continue;
          const secs = t.base / ts;
          if (!Number.isFinite(secs) || secs < 0) continue;
          if (minT === null || secs < minT) minT = secs;
          if (indexer.videoTrackId !== null && t.trackId === indexer.videoTrackId) {
            if (videoT === null || secs < videoT) videoT = secs;
          }
        }
        startTime = videoT ?? minT;
      }
      if (startTime !== null) {
        const frag: Fmp4Fragment = {
          index: indexer.fragments.length,
          startTime,
          spoolOffset: fragStart,
          endOffset: fragEnd,
          size: h.size + h2.size,
          sequence: extractSequence(moofBuf),
        };
        indexer.fragments.push(frag);
        emitted.push(frag);
      }
      // Consume both boxes whether or not a time was derivable (keeps the
      // cursor advancing; time-less boxes simply aren't seekable).
      indexer.pending = indexer.pending.subarray(h.size + h2.size);
      indexer.parseOffset = fragEnd;
      continue;
    }
    // Non-moof top-level box (mdat without moof, mfra, sidx, free, ...):
    // consume and continue (never emitted as seekable).
    indexer.pending = indexer.pending.subarray(h.size);
    indexer.parseOffset += h.size;
  }
  return emitted;
}

/** Nearest fragment with startTime <= t, or null (before first / empty). */
export function resolveTimeToFragment(fragments: Fmp4Fragment[], t: number): Fmp4Fragment | null {
  if (!Number.isFinite(t) || fragments.length === 0) return null;
  if (t < 0) return null;
  let best: Fmp4Fragment | null = null;
  for (const f of fragments) {
    if (f.startTime <= t) best = f;
    else break; // fragments are in startTime order (monotonic tfdt)
  }
  return best;
}

/**
 * Fragment containing spool byte `b`, else the nearest fragment starting at
 * or before `b` (snap back to safety). Null when `b` precedes the first
 * fragment. NEVER snaps forward.
 */
export function resolveByteToFragment(fragments: Fmp4Fragment[], b: number): Fmp4Fragment | null {
  if (!Number.isFinite(b) || fragments.length === 0) return null;
  let best: Fmp4Fragment | null = null;
  for (const f of fragments) {
    if (b >= f.endOffset) {
      best = f;
      continue;
    }
    if (b >= f.spoolOffset) return f; // inside (or exactly at start)
    break; // b is before this fragment's start: keep earlier best
  }
  return best;
}

/**
 * Drop every fragment at/after `spoolOffset` (spool truncation safety).
 * Returns the number of removed entries.
 */
export function invalidateFromOffset(indexer: Fmp4Indexer, spoolOffset: number): number {
  const before = indexer.fragments.length;
  indexer.fragments = indexer.fragments.filter((f) => f.endOffset <= spoolOffset);
  return before - indexer.fragments.length;
}
