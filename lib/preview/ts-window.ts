/**
 * MPEG-TS window → decodable random-access cut.
 *
 * The bounded TS acquisition fetches arbitrary 752-byte-aligned windows that
 * almost always begin in the middle of a GOP. Feeding that straight to the
 * decoder makes libopenh264 error on every non-keyframe packet until the
 * process error-rate watchdog aborts the thread (exit 69, "Error submitting
 * packet to decoder").
 *
 * The fix is a deterministic, buffer-level trim: find the first IDR that is
 * decodable in isolation — i.e. an SPS and a PPS appear before it in the
 * stream and no non-IDR VCL NAL intervenes between that pair and the IDR —
 * then keep the bytes from the TS packet (PUSI) that carries the group.
 * Annex-B start codes are scanned directly; no PES/PTS parsing is needed.
 * The result starts with a self-contained random-access group: ffmpeg
 * decodes from the first packet without any decoder-error burst.
 *
 * Callers treat `null` as "no decodable keyframe in this window" and omit
 * the scene (or the whole segment) instead of feeding garbage to ffmpeg.
 */

export const TS_PACKET_SIZE = 188;

/** True when `buf[off]` is a valid TS sync byte at `off`. */
function isSync(buf: Buffer, off: number): boolean {
  return off + TS_PACKET_SIZE <= buf.length && buf[off] === 0x47;
}

/**
 * Offsets of payload-unit-start-indicator packets (and the PIDs they open)
 * in a TS stream made of 188-byte packets. Returns null when the buffer is
 * not aligned TS at offset 0.
 */
export function findTsPushStartPackets(buf: Buffer): Array<{ offset: number; pid: number }> | null {
  if (buf.length < TS_PACKET_SIZE || buf[0] !== 0x47) return null;
  const out: Array<{ offset: number; pid: number }> = [];
  for (let off = 0; off + TS_PACKET_SIZE <= buf.length; off += TS_PACKET_SIZE) {
    if (buf[off] !== 0x47) return null; // mid-stream desync: not a TS window
    const pusi = (buf[off + 1] >> 6) & 1;
    const pid = ((buf[off + 1] & 0x1f) << 8) | buf[off + 2];
    if (pusi === 1) out.push({ offset: off, pid });
  }
  return out;
}

/** H.264 NAL types we care about (Annex-B). */
const NAL_IDR = 5;
const NAL_SEI = 6;
const NAL_SPS = 7;
const NAL_PPS = 8;

/** True for VCL non-IDR NAL types (1..4). */
function isNonIdrVcl(type: number): boolean {
  return type >= 1 && type <= 4;
}

interface NalUnit {
  offset: number;
  type: number;
}

/** Scan Annex-B start codes (00 00 01 and 00 00 00 01). */
function scanAnnexBNals(buf: Buffer): NalUnit[] {
  const nals: NalUnit[] = [];
  let i = 0;
  const end = buf.length;
  while (i + 4 <= end) {
    let start = -1;
    let prefix = 0;
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      start = i + 3;
      prefix = 3;
    } else if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 1) {
      start = i + 4;
      prefix = 4;
    }
    if (start >= 0 && start < end) {
      nals.push({ offset: i, type: buf[start] & 0x1f });
      i = start + 1; // continue scan right after the NAL header byte
      continue;
    }
    i += 1;
  }
  return nals;
}

/**
 * Offset of the byte that should become byte 0 of a decodable TS window, or
 * null when no self-contained random-access group exists in `buf`.
 *
 * Works on the decrypted plaintext of the window. The returned offset is
 * always a 188-byte packet boundary.
 */
export function findTsRandomAccessOffset(buf: Buffer): number | null {
  const pusiPackets = findTsPushStartPackets(buf);
  if (!pusiPackets || pusiPackets.length === 0) return null;
  const nals = scanAnnexBNals(buf);
  if (nals.length === 0) return null;

  for (let k = 0; k < nals.length; k++) {
    if (nals[k].type !== NAL_IDR) continue;
    const idrPos = nals[k].offset;
    let spsPos: number | null = null;
    let ppsPos: number | null = null;
    for (let j = k - 1; j >= 0; j--) {
      const t = nals[j].type;
      if (t === NAL_SPS && spsPos === null) spsPos = nals[j].offset;
      else if (t === NAL_PPS && ppsPos === null) ppsPos = nals[j].offset;
      if (spsPos !== null && ppsPos !== null) break;
    }
    if (spsPos === null || ppsPos === null) continue;
    const groupStart = Math.min(spsPos, ppsPos);
    // A non-IDR VCL NAL between the parameter sets and the IDR would be
    // fed to the decoder before any frame it can use — the exact error-burst
    // this trim exists to prevent. SEI/AUD are harmless.
    let decodable = true;
    for (const n of nals) {
      if (n.offset >= groupStart && n.offset < idrPos && isNonIdrVcl(n.type)) {
        decodable = false;
        break;
      }
    }
    if (!decodable) continue;
    // Keep from the packet that starts the PES carrying the group; the
    // demuxer needs the PES header to route SPS/PPS/IDR to the video stream.
    let trim = -1;
    for (const p of pusiPackets) {
      if (p.offset <= groupStart) trim = p.offset;
      else break;
    }
    if (trim < 0) return null; // group opens before any packet starts — unusable
    // Reasonable sanity bound: a group must fit inside the window.
    if (trim >= buf.length) return null;
    return trim;
  }
  return null;
}

/**
 * Trim a window file in place to the first decodable random-access group.
 * Returns true when the file was trimmed (or already starts at one), false
 * when no decodable group exists (file is deleted by the caller's cleanup).
 */
export async function trimTsFileToKeyframe(filePath: string): Promise<boolean> {
  const fs = await import('node:fs');
  const buf = await fs.promises.readFile(filePath);
  const offset = findTsRandomAccessOffset(buf);
  if (offset === null) return false;
  if (offset === 0) return true;
  const trimmed = buf.subarray(offset);
  const tmp = `${filePath}.trim`;
  await fs.promises.writeFile(tmp, trimmed);
  await fs.promises.rename(tmp, filePath);
  return true;
}
