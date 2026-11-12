/**
 * Phase 5 preview system: minimal MP4 top-level box walker.
 *
 * Only what the bounded sparse-source strategy needs: locate the moov atom
 * (its extent decides where the index bytes live) and detect whether mdat
 * precedes moov (non-faststart). Sample-level seeking is left entirely to
 * ffmpeg's own index handling — we never parse stco/stsz ourselves.
 *
 * Handles 32-bit sizes, 64-bit `largesize` (size==1) and the "extends to
 * end of file" size==0 form. Returns null on malformed data — callers keep
 * a safe fallback (never worse than no preview).
 */

export interface Mp4Box {
  type: string;
  /** Absolute start offset within the inspected buffer's coordinate space. */
  start: number;
  size: number;
}

/**
 * Walk top-level boxes of `buf` (which may be a head or a tail chunk of the
 * source; `baseOffset` maps buffer offsets to absolute file offsets).
 * Stops at the first incomplete/malformed box boundary.
 */
export function walkTopLevelBoxes(buf: Buffer, baseOffset = 0): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let off = 0;
  for (;;) {
    if (off + 8 > buf.length) break;
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size === 1) {
      // 64-bit largesize follows the type.
      if (off + 16 > buf.length) break;
      const hi = buf.readUInt32BE(off + 8);
      const lo = buf.readUInt32BE(off + 12);
      const big = hi * 2 ** 32 + lo;
      if (!Number.isSafeInteger(big) || big < 16) break;
      boxes.push({ type, start: baseOffset + off, size: big });
      off += big > Number.MAX_SAFE_INTEGER ? buf.length - off : big;
    } else if (size === 0) {
      // Extends to end of file (usually mdat last).
      boxes.push({ type, start: baseOffset + off, size: buf.length - off });
      off = buf.length;
      break;
    } else if (size < 8) {
      break; // malformed
    } else {
      boxes.push({ type, start: baseOffset + off, size });
      off += size;
    }
    if (off >= buf.length) break;
  }
  return boxes;
}

export interface MoovLocation {
  /** Absolute offset of the moov box start in the source file. */
  start: number;
  /** Absolute offset one past the moov box end. */
  end: number;
  /** True when the inspected buffer contains the whole moov box. */
  complete: boolean;
  /** True when mdat appears before moov in the inspected range (non-faststart evidence). */
  mdatBeforeMoov: boolean;
}

/**
 * Locate moov among the walked boxes. `complete` is false when the buffer
 * ends inside the moov box (index larger than the fetch — caller decides
 * whether to fetch more or bail).
 */
export function findMoov(buf: Buffer, baseOffset = 0): MoovLocation | null {
  const boxes = walkTopLevelBoxes(buf, baseOffset);
  let mdatSeen = false;
  for (const box of boxes) {
    if (box.type === 'mdat') mdatSeen = true;
    if (box.type !== 'moov') continue;
    const complete = box.start - baseOffset + box.size <= buf.length;
    return {
      start: box.start,
      end: box.start + box.size,
      complete,
      mdatBeforeMoov: mdatSeen,
    };
  }
  return null;
}

/**
 * Validate the faststart property of a complete (small) MP4 file: the moov
 * index must appear before the first mdat payload. Returns `unknown` when
 * the box walk cannot prove either layout.
 */
export function faststartVerdict(buf: Buffer): 'faststart' | 'not-faststart' | 'unknown' {
  const boxes = walkTopLevelBoxes(buf, 0);
  let moovAt: number | null = null;
  let mdatAt: number | null = null;
  for (const box of boxes) {
    if (box.type === 'moov' && moovAt === null) moovAt = box.start;
    if (box.type === 'mdat' && mdatAt === null) mdatAt = box.start;
  }
  if (moovAt === null) return 'unknown';
  if (mdatAt === null) return 'faststart';
  return moovAt < mdatAt ? 'faststart' : 'not-faststart';
}

/**
 * Read the movie duration from an `mvhd` child of a located, complete moov.
 * This is the authoritative duration for MP4/M4V files even when the
 * database row has no duration (MEGA sync does not always populate it).
 * Returns null for a malformed/truncated index; callers keep the bounded
 * unknown-duration fallback instead of inventing a timestamp.
 */
export function mvhdDurationSeconds(
  buf: Buffer,
  moov: MoovLocation,
  baseOffset = 0,
): number | null {
  if (!moov.complete) return null;
  const moovStart = moov.start - baseOffset;
  const moovEnd = moov.end - baseOffset;
  if (moovStart < 0 || moovEnd > buf.length || moovEnd - moovStart < 16) return null;
  let off = moovStart + 8;
  while (off + 8 <= moovEnd) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (size < 8 || off + size > moovEnd) return null;
    if (type === 'mvhd') {
      if (off + 12 > buf.length) return null;
      const version = buf.readUInt8(off + 8);
      if (version === 1) {
        if (off + 40 > buf.length) return null;
        const timescale = buf.readUInt32BE(off + 28);
        const duration = Number(buf.readBigUInt64BE(off + 32));
        if (!Number.isFinite(duration) || duration <= 0 || timescale <= 0) return null;
        return duration / timescale;
      }
      if (off + 28 > buf.length) return null;
      const timescale = buf.readUInt32BE(off + 20);
      const duration = buf.readUInt32BE(off + 24);
      if (!Number.isFinite(duration) || duration <= 0 || timescale <= 0) return null;
      return duration / timescale;
    }
    off += size;
  }
  return null;
}

/** Convenience: locate a complete moov in a head/tail chunk and read mvhd. */
export function readMp4DurationSeconds(
  buf: Buffer,
  baseOffset = 0,
  totalSize?: number,
): number | null {
  const moov = findMoovInChunk(buf, baseOffset, totalSize);
  if (!moov) return null;
  return mvhdDurationSeconds(buf, moov, baseOffset);
}

/**
 * Locate moov in a chunk that may begin mid-box. Tail chunks almost always
 * start inside the mdat payload, so the sequential walker cannot reach the
 * moov — scan for the `moov` type bytes instead and validate every candidate
 * structurally:
 *
 *  - the 4 bytes before the type must be a plausible 32-bit box size
 *    (moov is never a 64-bit `largesize` box in real layouts),
 *  - the box must fit inside the file when `totalSize` is known,
 *  - the first child box — which always exists and is always `mvhd` for a
 *    valid moov — must be present, with a sane child size.
 *
 * Random "moov" byte sequences inside mdat payloads cannot satisfy the mvhd
 * child check, so false positives are effectively impossible. The sequential
 * walk is tried first (exact top-level layout, mdatBeforeMoov evidence).
 */
export function findMoovInChunk(
  buf: Buffer,
  baseOffset = 0,
  totalSize?: number,
): MoovLocation | null {
  const walked = findMoov(buf, baseOffset);
  if (walked) return walked;

  let from = 4;
  for (;;) {
    const at = buf.indexOf('moov', from, 'latin1');
    if (at < 0) return null;
    from = at + 1;
    const startInBuf = at - 4;
    if (startInBuf < 0) continue;
    const size = buf.readUInt32BE(startInBuf);
    if (size < 16) continue; // not a real top-level moov
    const absStart = baseOffset + startInBuf;
    const absEnd = absStart + size;
    if (totalSize !== undefined && absEnd > totalSize) continue;
    // A valid moov's first child is mvhd: [size(4)][type(4)] at at+4.
    if (at + 12 > buf.length) continue;
    const childSize = buf.readUInt32BE(at + 4);
    if (childSize < 8) continue;
    if (buf.toString('latin1', at + 8, at + 12) !== 'mvhd') continue;
    const complete = absEnd <= baseOffset + buf.length;
    return { start: absStart, end: absEnd, complete, mdatBeforeMoov: false };
  }
}
