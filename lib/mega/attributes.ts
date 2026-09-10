/**
 * MEGA file attributes (thumbnails, previews, media properties) for
 * AUTHENTICATED (private) nodes.
 *
 * Same wire protocol as the public-link flow in ./thumbnail.ts, but the API
 * call goes through a logged-in megajs API client so the request carries the
 * account's session id:
 *
 *   1. the node's `fa` string (from the authenticated a=f response) lists
 *      attributes: "version:type*handle" (0=thumbnail, 1=preview, 8=media).
 *   2. a=ufa with the attribute handle returns a storage URL.
 *   3. a binary POST to that URL returns [handle:8][len:4][ciphertext].
 *   4. the blob is AES-128-CBC decrypted (zero IV) with the key derived from
 *      the file key (first 16 bytes XOR last 16 bytes).
 *
 * Images decrypt to PNG/JPEG bytes; the media attribute decrypts to a JSON
 * document (e.g. {"duration": ...}).
 */

import crypto from 'node:crypto';
import { b64UrlToBuffer } from './util';
import { parseFa, foldKey } from './nodes';

/** Minimal shape of a megajs API client. */
export interface ApiLike {
  request(json: Record<string, unknown>): Promise<unknown>;
}

interface ApiResponse {
  p?: string;
  [key: string]: unknown;
}

export type PrivateMegaImageKind = 'thumbnail' | 'preview';

export interface PrivateMegaImage {
  /** Decrypted image bytes (JPEG or PNG). */
  data: Buffer;
  /** Detected MIME type. */
  mimeType: string;
}

async function fetchFileAttributeRaw(api: ApiLike, handle: string): Promise<Buffer | null> {
  const handleBytes = b64UrlToBuffer(handle);
  const ufa = (await api.request({
    a: 'ufa',
    fah: handle,
    ssl: 2,
    r: 1,
    v: 3,
  })) as ApiResponse | null;

  if (!ufa || typeof ufa.p !== 'string') return null;

  const resp = await fetch(ufa.p, {
    method: 'POST',
    body: new Uint8Array(handleBytes),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) return null;

  const data = Buffer.from(await resp.arrayBuffer());
  if (data.length < 12) return null;

  const len = data.readUInt32LE(8);
  if (len < 0 || 12 + len > data.length) return null;
  return data.subarray(12, 12 + len);
}

function decryptFileAttribute(encrypted: Buffer, fileKey: Buffer): Buffer {
  if (fileKey.length !== 32) {
    throw new Error(`Unexpected MEGA file key length ${fileKey.length}`);
  }
  const aesKey = foldKey(fileKey);
  const decipher = crypto.createDecipheriv('aes-128-cbc', aesKey, Buffer.alloc(16, 0));
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function sniffMimeType(data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  return 'application/octet-stream';
}

/**
 * Fetch and decrypt an image attribute (thumbnail/preview) of a private node.
 *
 * @param fa Raw `fa` string of the node (from the authenticated fetch).
 * @param fileKey The 32-byte file key of the node.
 * @returns The decrypted image, or null if the attribute is missing/invalid.
 */
export async function getPrivateNodeImage(
  api: ApiLike,
  fa: string | null,
  kind: PrivateMegaImageKind,
  fileKey: Buffer,
): Promise<PrivateMegaImage | null> {
  const attrs = parseFa(fa);
  const handle = kind === 'thumbnail' ? attrs[0] : attrs[1];
  if (!handle) return null;

  const encrypted = await fetchFileAttributeRaw(api, handle);
  if (!encrypted) return null;

  let data: Buffer;
  try {
    data = decryptFileAttribute(encrypted, fileKey);
  } catch {
    return null;
  }
  const mimeType = sniffMimeType(data);
  if (mimeType === 'application/octet-stream') return null;

  return { data, mimeType };
}

export interface MediaProperties {
  /** Best-effort duration in whole seconds (null when unknown). */
  durationSeconds: number | null;
}

/**
 * Normalize a MEGA media-attribute duration to whole seconds.
 * MEGA reports duration in microseconds (ffmpeg units); the ms/s fallbacks
 * make the field useful if MEGA ever changes units.
 */
export function normalizeDurationToSeconds(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  let seconds: number;
  if (v >= 1_000_000) seconds = v / 1_000_000; // microseconds
  else if (v >= 1_000) seconds = v / 1_000; // milliseconds
  else seconds = v; // already seconds
  return Math.max(0, Math.round(seconds));
}

/**
 * Fetch and decrypt the media-properties attribute of a private video node.
 * Returns null when the node has no media attribute (very common for
 * non-video files and some uploads).
 */
export async function getPrivateNodeMediaProperties(
  api: ApiLike,
  fa: string | null,
  fileKey: Buffer,
): Promise<MediaProperties | null> {
  const attrs = parseFa(fa);
  const handle = attrs[8];
  if (!handle) return null;

  const encrypted = await fetchFileAttributeRaw(api, handle);
  if (!encrypted) return null;

  let data: Buffer;
  try {
    data = decryptFileAttribute(encrypted, fileKey);
  } catch {
    return null;
  }
  try {
    const json = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
    return { durationSeconds: normalizeDurationToSeconds(json.duration) };
  } catch {
    return null;
  }
}
