/**
 * Shared low-level MEGA node operations (delete + rename).
 *
 * Both the bulk duplicate-deletion endpoints and the single-video
 * rename/delete endpoints go through these helpers so there is exactly ONE
 * implementation of each destructive MEGA operation:
 *
 *   - delete: permanent `a=d` (moves nothing to rubbish, frees the bytes).
 *   - rename: `a=a` with a re-encrypted `{ n: newName }` attribute blob
 *     (the same wire format megajs' `File.rename()` produces: `MEGA` +
 *     JSON, zero-padded to 16 bytes, AES-128-CBC encrypted with the folded
 *     file key under a zero IV, base64url-encoded).
 *
 * Session handling (resume/verify/evict) stays with the callers via
 * `withMegaSession` - this module never sees passwords or session material.
 */

import crypto from 'node:crypto';
import type { Storage } from 'megajs';

const MEGA_API_TIMEOUT_MS = 30_000;

/** Bounded MEGA request (mirrors the timeout discipline of lib/mega/account). */
export function megaRequest(storage: Storage, cmd: Record<string, unknown>): Promise<unknown> {
  const request = storage.api.request as unknown as (
    cmd: Record<string, unknown>,
  ) => Promise<unknown>;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('MEGA API request timed out (temporarily unavailable)'));
    }, MEGA_API_TIMEOUT_MS);
    const t = timer as unknown as { unref?: unknown };
    if (typeof t.unref === 'function') (t as unknown as { unref(): void }).unref();
  });
  const pending = request.call(storage.api, cmd);
  pending.catch(() => {});
  return Promise.race([pending, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** True when MEGA reports the target node is gone (-9 ENOENT outside login). */
export function isNotFoundError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /\(-9\)/.test(text);
}

/**
 * Permanently delete one node (`a=d`). Throws on failure; callers map
 * "already gone" via {@link isNotFoundError}.
 */
export async function deleteMegaNode(storage: Storage, nodeId: string): Promise<void> {
  await megaRequest(storage, { a: 'd', n: nodeId });
}

/**
 * Fold a 32-byte MEGA file key to the 16-byte attribute cipher key
 * (first half XOR second half - identical to megajs' unmergeKeyMac slice).
 */
export function foldFileKey(fileKey: Buffer): Buffer {
  if (fileKey.length !== 32) throw new Error('MEGA file key must be 32 bytes');
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) out[i] = fileKey[i] ^ fileKey[16 + i];
  return out;
}

/**
 * Pack `{ n: name }` into the encrypted `at` blob MEGA expects for `a=a`.
 * Pure and unit-testable: the output decrypts (CBC, folded key, zero IV)
 * back to `MEGA{"n":"<name>"}`.
 */
export function packNodeNameAttribute(fileKey: Buffer, name: string): string {
  const at = Buffer.from(`MEGA${JSON.stringify({ n: name })}`, 'utf8');
  const padded = Buffer.alloc(Math.ceil(at.length / 16) * 16);
  at.copy(padded);
  const cipher = crypto.createCipheriv('aes-128-cbc', foldFileKey(fileKey), Buffer.alloc(16, 0));
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  return enc.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Rename one node to `newName` (`a=a`). Throws on failure; callers map
 * "already gone" via {@link isNotFoundError}.
 *
 * Only the name attribute is rewritten - the same payload megajs'
 * `File.rename()` sends for files whose attribute blob carries just the
 * name (video files have no other node attributes; `fa`/keys/size live
 * outside the attribute blob and are untouched).
 */
export async function renameMegaNode(
  storage: Storage,
  nodeId: string,
  fileKey: Buffer,
  newName: string,
): Promise<void> {
  const at = packNodeNameAttribute(fileKey, newName);
  await megaRequest(storage, { a: 'a', n: nodeId, at });
}
