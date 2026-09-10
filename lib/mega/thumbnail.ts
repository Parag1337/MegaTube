/**
 * MEGA thumbnail/preview extraction.
 *
 * MEGA stores thumbnails and previews as *file attributes* - small
 * encrypted blobs attached to the file. This module implements the same
 * flow the official clients use, purely over HTTP:
 *
 *   1. `a=g` (via megajs) reveals the `fa` string listing file attributes
 *      (`version:type*handle`), where type 0 = thumbnail, 1 = preview.
 *   2. `a=ufa` with the attribute handle returns a storage URL.
 *   3. A binary POST to that URL returns `[handle:8][len:4][encrypted data]`.
 *   4. The blob is AES-128-CBC decrypted with a key derived from the file
 *      key (first 16 bytes XOR last 16 bytes) and a zero IV.
 *
 * No account/session is required - this works for public links.
 */

import crypto from 'node:crypto';
import { b64UrlToBuffer, bufferToB64Url } from './util';
import type { MegaFileLink } from './parser';
import { parseMegaFileAttributes } from './metadata';

const MEGA_API = 'https://g.api.mega.co.nz/cs';

export type MegaImageKind = 'thumbnail' | 'preview';

export interface MegaImage {
  /** Decrypted image bytes (JPEG or PNG). */
  data: Buffer;
  /** Detected MIME type. */
  mimeType: string;
}

interface ApiResponse {
  p?: string;
  [key: string]: unknown;
}

async function apiCall(cmd: Record<string, unknown>): Promise<ApiResponse | null> {
  const res = await fetch(`${MEGA_API}?id=${Math.floor(Math.random() * 1e9)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd]),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`MEGA API error ${res.status}`);
  }
  const json = (await res.json()) as unknown[];
  return (json[0] as ApiResponse | undefined) ?? null;
}

async function fetchFileAttribute(handle: string): Promise<Buffer | null> {
  const handleBytes = b64UrlToBuffer(handle);
  const ufa = await apiCall({
    a: 'ufa',
    fah: bufferToB64Url(handleBytes),
    ssl: 2,
    r: 1,
    v: 3,
  });

  if (!ufa || typeof ufa.p !== 'string') {
    return null;
  }

  const postUrl: string = ufa.p;

  const resp = await fetch(postUrl, {
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

/** AES-128-CBC decrypt with derived key (k[0:16] XOR k[16:32]) and zero IV. */
function decryptFileAttribute(encrypted: Buffer, megaFileKey: string): Buffer {
  const fullKey = b64UrlToBuffer(megaFileKey);
  if (fullKey.length !== 32) {
    throw new Error(`Unexpected MEGA file key length ${fullKey.length}`);
  }

  const aesKey = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) aesKey[i] = fullKey[i] ^ fullKey[i + 16];

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
 * Fetch and decrypt a MEGA file attribute image (thumbnail or preview) for a
 * public file link.
 *
 * @param link Parsed MEGA file link.
 * @param kind Which attribute to fetch.
 * @param fa Optional raw `fa` string from a prior metadata call; if omitted
 *   the metadata call is repeated.
 * @returns The decrypted image, or null if the file has no such attribute.
 */
export async function getMegaImage(
  link: MegaFileLink,
  kind: MegaImageKind = 'thumbnail',
  fa?: string | null,
): Promise<MegaImage | null> {
  let faString = fa;
  if (!faString) {
    const { getMegaMetadata } = await import('./metadata');
    const meta = await getMegaMetadata(link);
    faString = meta.fa;
  }

  const attrs = parseMegaFileAttributes(faString);
  const handle = kind === 'thumbnail' ? attrs.thumbnail : attrs.preview;
  if (!handle) return null;

  const encrypted = await fetchFileAttribute(handle);
  if (!encrypted) return null;

  const data = decryptFileAttribute(encrypted, link.megaFileKey);
  const mimeType = sniffMimeType(data);
  if (mimeType === 'application/octet-stream') return null;

  return { data, mimeType };
}