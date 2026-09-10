/**
 * In-memory cache of live MEGA sessions, one per MegaAccount.
 *
 * A resumed session (megajs Storage) is relatively cheap to keep, and
 * playback + sync + thumbnails all need it. We cache per account id with a
 * short TTL; on eviction we close the transport WITHOUT sending sml (the
 * session must keep living on MEGA's side).
 *
 * The cache is process-local: after a server restart the next use simply
 * resumes the session from the encrypted DB material (no password needed).
 */

import type { Storage } from 'megajs';
import { decryptSecret } from '../mega/envelope';
import { openMegaSession, closeMegaSession, validateSessionMaterial, MegaError } from '../mega/account';
import type { MegaSessionMaterial } from '../mega/account';

interface CacheEntry {
  storage: Storage;
  openedAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000;

const globalForCache = globalThis as unknown as {
  megaSessionCache?: Map<number, CacheEntry>;
};

function cache(): Map<number, CacheEntry> {
  if (!globalForCache.megaSessionCache) {
    globalForCache.megaSessionCache = new Map();
  }
  return globalForCache.megaSessionCache;
}

/**
 * Run `fn` with a validated live MEGA session for the given stored blob.
 * Handles caching, TTL eviction, and transparent session resumption.
 *
 * @throws {MegaError} kind 'session-expired' when MEGA rejects the stored
 *   session, 'transient' for network/congestion problems.
 */
export async function withMegaSession<T>(
  accountId: number,
  encryptedSession: string,
  fn: (storage: Storage) => Promise<T>,
): Promise<T> {
  const c = cache();
  const now = Date.now();
  const entry = c.get(accountId);

  if (entry && now - entry.openedAt < CACHE_TTL_MS) {
    return fn(entry.storage);
  }

  if (entry) {
    c.delete(accountId);
    closeMegaSession(entry.storage);
  }

  let material: MegaSessionMaterial;
  try {
    material = JSON.parse(decryptSecret(encryptedSession).toString('utf8')) as MegaSessionMaterial;
  } catch {
    throw new MegaError('session-expired', 'Stored MEGA session could not be decrypted');
  }
  if (!validateSessionMaterial(material)) {
    throw new MegaError('session-expired', 'Stored MEGA session is malformed');
  }

  const storage = await openMegaSession(material);
  c.set(accountId, { storage, openedAt: Date.now() });
  return fn(storage);
}

/** Evict one account (after disconnect / reauth / a dead session). */
export function evictMegaSession(accountId: number): void {
  const entry = cache().get(accountId);
  if (entry) {
    cache().delete(accountId);
    closeMegaSession(entry.storage);
  }
}

/** Evict everything (shutdown / test isolation). */
export function evictAllMegaSessions(): void {
  for (const id of [...cache().keys()]) evictMegaSession(id);
}
