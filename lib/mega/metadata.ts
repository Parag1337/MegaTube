/**
 * MEGA metadata retrieval.
 *
 * Uses `megajs` (a maintained Node port of the official MEGA JS SDK) to
 * resolve public file links. We issue the `a=g` API request through the
 * library's own API client and decrypt the encrypted node attributes (which
 * contain the filename) using the library's crypto primitives and the file
 * key from the link.
 *
 * The response also carries the `fa` field, which lists the MEGA file
 * attributes (thumbnail / preview / media properties) available for the file.
 */

import * as Mega from 'megajs';
import type { MegaFileLink } from './parser';

export interface MegaMetadata {
  /** Decrypted file name as stored on MEGA, e.g. "AmazingVideo123.mp4". */
  filename: string;
  /** File size in bytes. */
  size: number;
  /** File creation timestamp (seconds since epoch), if known. */
  timestamp: number | null;
  /** Raw file-attribute string from the API ("version:type*handle/..."). */
  fa: string | null;
  /** True if MEGA reports a thumbnail file attribute (type 0). */
  thumbnailAvailable: boolean;
  /** True if MEGA reports a preview file attribute (type 1). */
  previewAvailable: boolean;
}

/**
 * Parse a MEGA file-attribute string:
 *   "703:0*Oyfc2P638oI/703:1*imAXmOeaR9U/715:8*XBZiq1cRSsY"
 * Each part is `version:type*handle`, where type 0 = thumbnail,
 * 1 = preview, 8 = media properties.
 */
export function parseMegaFileAttributes(
  fa: string | null | undefined,
): {
  thumbnail: string | null;
  preview: string | null;
  media: string | null;
} {
  const out = {
    thumbnail: null as string | null,
    preview: null as string | null,
    media: null as string | null,
  };
  if (!fa) return out;

  for (const part of String(fa).split('/')) {
    const m = part.match(/^(\d+):(\d+)\*(.+)$/);
    if (!m) continue;
    const type = Number(m[2]);
    const handle = m[3];
    if (type === 0) out.thumbnail = handle;
    else if (type === 1) out.preview = handle;
    else if (type === 8) out.media = handle;
  }
  return out;
}

/**
 * Resolve metadata for a MEGA public file link.
 *
 * @throws on network errors, invalid links, or undecryptable attributes.
 */
export function getMegaMetadata(link: MegaFileLink | string): Promise<MegaMetadata> {
  const url = typeof link === 'string' ? link : link.url;
  const file = Mega.File.fromURL(url);

  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    file.api.request({ a: 'g', p: file.downloadId } as any, (err: Error | null, response?: any) => {
      if (err) {
        reject(new Error(`Failed to load MEGA metadata: ${err.message}`));
        return;
      }
      if (!response || typeof response.s !== 'number') {
        reject(new Error('MEGA returned no file information for this link'));
        return;
      }

      // Decrypt the node attributes (contains the filename). decryptAttributes
      // is a public method on the megajs File class.
      let filename = '';
      try {
        if (response.at) {
          file.decryptAttributes(response.at);
          filename = file.name ?? '';
        }
      } catch {
        filename = '';
      }

      const attrs = parseMegaFileAttributes(response.fa);

      resolve({
        filename,
        size: response.s,
        timestamp: typeof response.t === 'number' ? response.t : null,
        fa: response.fa ?? null,
        thumbnailAvailable: Boolean(attrs.thumbnail),
        previewAvailable: Boolean(attrs.preview),
      });
    });
  });
}