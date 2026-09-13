/**
 * MEGA node-tree decoding.
 *
 * Decodes the raw `a=f c=1` (fetch all nodes) API response for a logged-in
 * account. This mirrors what the official SDK does internally:
 *
 *   - each node `f` carries: h (node handle), p (parent), t (type: 0=file,
 *     1=folder, 2=cloud drive root, 3=inbox, 4=rubbish bin), ts (timestamp),
 *     s (size), u (owner), at (CBC-encrypted attributes incl. filename),
 *     fa (file attributes list, "version:type*handle/..."),
 *     k (node key, one of "ownerId:base64key/..." alternatives)
 *   - the node key for our own files is AES-128-ECB encrypted with the 16-byte
 *     master key; for received shares it is ECB encrypted with the share key
 *     (recovered from `ok`); some nodes carry an RSA-encrypted key instead
 *     (decrypted with the account RSA private key).
 *   - node attributes are AES-128-CBC (zero IV) encrypted with the folded
 *     file key (first 16 bytes XOR last 16 bytes).
 *
 * MEGA nodes do not carry a MIME type in the API; video detection therefore
 * combines the filename extension with the presence of a media-properties
 * file attribute (type 8 in `fa`).
 */

import crypto from 'node:crypto';
import { File } from 'megajs';
import { b64UrlToBuffer } from './util';

/** A decoded MEGA file node (files only; folders are filtered out). */
export interface DecodedFileNode {
  /** Node handle (stable identity). */
  h: string;
  /** Parent node handle, or null for root-level files. */
  p: string | null;
  /** Node type (0 = file). */
  t: number;
  /** MEGA timestamp (seconds since epoch), if known. */
  ts: number | null;
  /** Size in bytes. */
  s: number;
  /** Owner user id. */
  u: string | null;
  /** Decrypted filename, or null if it could not be decrypted. */
  name: string | null;
  /** Raw file-attribute string ("version:type*handle/..."), if any. */
  fa: string | null;
  /** 32-byte file key, or null if it could not be derived. */
  fileKey: Buffer | null;
}

export interface RawApiNode {
  h: string;
  p?: string | null;
  t: number;
  ts?: number | null;
  s?: number | null;
  u?: string | null;
  /** Encrypted attributes blob. Field name varies: `a` on a=f responses, `at` elsewhere. */
  a?: string;
  at?: string;
  fa?: string | null;
  k?: string;
}

export interface RawFetchResponse {
  f?: RawApiNode[];
  ok?: Array<{ h: string; ha: string; k: string }>;
  [key: string]: unknown;
}

/** AES-128-ECB (no padding; MEGA buffers are block-aligned). */
function ecbDecrypt(key: Buffer, data: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-128-ecb', key, Buffer.alloc(0));
  d.setAutoPadding(false);
  return Buffer.concat([d.update(data), d.final()]);
}

function ecbEncrypt(key: Buffer, data: Buffer): Buffer {
  const c = crypto.createCipheriv('aes-128-ecb', key, Buffer.alloc(0));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(data), c.final()]);
}

/** Fold a 32-byte file key to the 16-byte AES key: k[i] ^= k[i+16]. */
export function foldKey(fileKey: Buffer): Buffer {
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = fileKey[i] ^ fileKey[i + 16];
  return out;
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface DecodedShareKey {
  /** Share folder node handle. */
  handle: string;
  /** 16-byte share key. */
  key: Buffer;
}

/**
 * Recover share keys from the `ok` array of a fetch response, verifying the
 * auth field exactly like the official client does.
 */
export function decodeShareKeys(
  ok: Array<{ h: string; ha: string; k: string }> | undefined,
  masterKey: Buffer,
): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!ok) return out;
  for (const share of ok) {
    if (!share?.h || !share?.ha || !share?.k) continue;
    let auth: Buffer;
    let key: Buffer;
    try {
      // Official clients compute the share auth tag as ECB(masterKey, h_b64 + h_b64)
      // where the input (24 bytes for standard 12-char handles) is NOT block-aligned:
      // only the first 16-byte block is encrypted/compared (C++ SDK
      // MegaClient::handleauth + SymmCipher::ecb_encrypt; megajs encryptECB
      // likewise only emits full blocks). ha is exactly 16 bytes.
      const doubled = Buffer.from(share.h + share.h, 'utf8');
      auth = ecbEncrypt(masterKey, doubled.subarray(0, 16));
      key = ecbDecrypt(masterKey, b64UrlToBuffer(share.k));
    } catch {
      continue;
    }
    if (constantTimeEqual(b64UrlToBuffer(share.ha), auth)) {
      out.set(share.h, key.subarray(0, 16));
    }
  }
  return out;
}

/**
 * Derive the 32-byte file key for a node.
 *
 * @param storageLike Must provide `decryptRsaKey(buffer)` for
 *   RSA-encrypted keys (a live MEGA session) - or null to disable RSA
 *   decryption (the key is then only resolvable for master-key shares).
 */
export function decodeFileKey(
  f: RawApiNode,
  me: string,
  masterKey: Buffer,
  shareKeys: Map<string, Buffer>,
  storageLike: { decryptRsaKey(ciphertext: Buffer): Buffer } | null,
): Buffer | null {
  if (!f.k) return null;
  let aesKey: Buffer | null = null;
  let chosen: string | null = null;
  for (const pair of f.k.split('/')) {
    const sep = pair.indexOf(':');
    if (sep <= 0) continue;
    const owner = pair.slice(0, sep);
    const keyB64 = pair.slice(sep + 1);
    if (owner === me) {
      chosen = keyB64;
      aesKey = masterKey;
      break;
    }
    const sk = shareKeys.get(owner);
    if (sk) {
      chosen = keyB64;
      aesKey = sk;
      break;
    }
  }
  if (!chosen || !aesKey) return null;

  let key = b64UrlToBuffer(chosen);
  if (key.length <= 32) {
    try {
      key = ecbDecrypt(aesKey, key);
    } catch {
      return null;
    }
  } else if (storageLike) {
    try {
      key = storageLike.decryptRsaKey(key).subarray(0, 32);
    } catch {
      return null;
    }
  } else {
    return null;
  }
  if (key.length !== 32) return null;
  return key;
}

/** Decrypt node attributes (base64url CBC blob) and return the attribute map. */
export function decodeAttributes(fileKey: Buffer, atB64: string): Record<string, unknown> | null {
  try {
    const at = b64UrlToBuffer(atB64);
    const d = crypto.createDecipheriv('aes-128-cbc', foldKey(fileKey), Buffer.alloc(16, 0));
    d.setAutoPadding(false);
    const plain = Buffer.concat([d.update(at), d.final()]);
    // Attributes are a packed stream; File.unpackAttributes (megajs) parses it.
    const attrs = File.unpackAttributes(plain);
    return (attrs as unknown as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse a raw `a=f c=1` response into decoded file nodes.
 *
 * @param raw Raw API response.
 * @param me Our MEGA user id.
 * @param masterKey 16-byte master key.
 * @param storageLike Session providing RSA decryption, or null.
 * @param onScanProgress Optional callback invoked with the running count of
 *   raw nodes examined (every 25 nodes) - used for real Phase-A progress.
 *   Invoked synchronously; keep the handler cheap.
 */
export function decodeFileNodes(
  raw: RawFetchResponse,
  me: string,
  masterKey: Buffer,
  storageLike: { decryptRsaKey(ciphertext: Buffer): Buffer } | null,
  onScanProgress?: (nodesScanned: number) => void,
): DecodedFileNode[] {
  const shareKeys = decodeShareKeys(raw.ok, masterKey);
  const out: DecodedFileNode[] = [];
  const all = raw.f ?? [];
  for (let i = 0; i < all.length; i++) {
    const f = all[i];
    if (onScanProgress && (i % 25 === 0 || i === all.length - 1)) {
      onScanProgress(i + 1);
    }
    if (!f || f.t !== 0 || !f.h) continue; // files only
    let fileKey: Buffer | null = null;
    try {
      fileKey = decodeFileKey(f, me, masterKey, shareKeys, storageLike);
    } catch {
      fileKey = null;
    }
    let name: string | null = null;
    const atBlob = f.a ?? f.at;
    if (fileKey && atBlob) {
      const attrs = decodeAttributes(fileKey, atBlob);
      if (attrs && typeof attrs.n === 'string') name = attrs.n;
    }
    out.push({
      h: f.h,
      p: f.p ?? null,
      t: f.t,
      ts: typeof f.ts === 'number' ? f.ts : null,
      s: typeof f.s === 'number' ? f.s : 0,
      u: f.u ?? null,
      name,
      fa: f.fa ?? null,
      fileKey,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Video detection
// ---------------------------------------------------------------------------

/** Common video container extensions (MEGA nodes carry no MIME type). */
export const VIDEO_EXTENSIONS = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'mpg', 'mpeg', 'wmv', 'flv', 'ts', '3gp', '3g2',
]);

export function extensionOf(filename: string | null): string | null {
  if (!filename) return null;
  const i = filename.lastIndexOf('.');
  if (i <= 0 || i === filename.length - 1) return null;
  return filename.slice(i + 1).toLowerCase();
}

/**
 * Parse "version:type*handle/version:type*handle/..." into a type->handle map.
 * type 0 = thumbnail, 1 = preview, 8 = media properties.
 */
export function parseFa(fa: string | null | undefined): { [type: number]: string } {
  const out: { [type: number]: string } = {};
  if (!fa) return out;
  for (const part of String(fa).split('/')) {
    const m = part.match(/^(\d+):(\d+)\*(.+)$/);
    if (!m) continue;
    out[Number(m[2])] = m[3];
  }
  return out;
}

/**
 * True if the node looks like a video: known video extension, or MEGA reports
 * a media-properties attribute (type 8) for it.
 */
export function isVideoNode(name: string | null, fa: string | null): boolean {
  const ext = extensionOf(name);
  if (ext && VIDEO_EXTENSIONS.has(ext)) return true;
  return Boolean(parseFa(fa)[8]);
}

/** MIME type by extension (best effort; MEGA provides none). */
export const MIME_BY_VIDEO_EXT: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ts: 'video/mp2t',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
};

export function mimeFromVideoExtension(name: string | null): string | null {
  const ext = extensionOf(name);
  return ext ? (MIME_BY_VIDEO_EXT[ext] ?? null) : null;
}

/**
 * Detect the MIME type of a video file from its first bytes.
 *
 * This is needed because MEGA nodes carry no MIME type and the extension
 * can be misleading (e.g. a .mp4 file that is actually an MPEG-TS stream).
 */
export function sniffMimeType(data: Buffer): string | null {
  if (data.length >= 188) {
    let tsPackets = 0;
    for (let i = 0; i < data.length; i += 188) {
      if (data[i] === 0x47) tsPackets++;
    }
    if (tsPackets >= Math.floor(data.length / 188) * 0.8) {
      return 'video/mp2t';
    }
  }
  if (data.length >= 8) {
    const size = data.readUInt32BE(0);
    if (size >= 8 && size <= data.length) {
      const type = data.subarray(4, 8).toString('latin1');
      if (type === 'ftyp') return 'video/mp4';
      if (type === 'webm') return 'video/webm';
    }
  }
  if (data.length >= 4 && data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return 'video/webm';
  }
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'AVI ') {
    return 'video/x-msvideo';
  }
  return null;
}
