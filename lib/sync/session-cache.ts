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

// In-flight session resumption per account id (single-flight): a burst of
// concurrent cold requests (homepage thumbnails + first playback after
// server start) used to trigger one FULL MEGA session resume per request -
// each a network round trip + crypto, observed as multi-second tail
// latencies. Concurrent waiters now share ONE resume.
const globalForInflight = globalThis as unknown as {
  megaSessionInflight?: Map<number, Promise<Storage>>;
};

function inflight(): Map<number, Promise<Storage>> {
  if (!globalForInflight.megaSessionInflight) {
    globalForInflight.megaSessionInflight = new Map();
  }
  return globalForInflight.megaSessionInflight;
}

const globalForCache = globalThis as unknown as {
  megaSessionCache?: Map<number, CacheEntry>;
};

// Test seam (same pattern as MediaDeps/SyncDeps): unit tests inject fakes
// for the decrypt/validate/open legs to exercise caching and single-flight
// without the MEGA network. Null in production.
interface MegaSessionLegs {
  decrypt: typeof decryptSecret;
  validate: typeof validateSessionMaterial;
  open: typeof openMegaSession;
}
const legs: MegaSessionLegs = {
  decrypt: decryptSecret,
  validate: validateSessionMaterial,
  open: openMegaSession,
};

export function __setMegaSessionLegsForTests(fakes: Partial<MegaSessionLegs> | null): void {
  if (fakes) {
    if (fakes.decrypt) legs.decrypt = fakes.decrypt;
    if (fakes.validate) legs.validate = fakes.validate;
    if (fakes.open) legs.open = fakes.open;
  } else {
    legs.decrypt = decryptSecret;
    legs.validate = validateSessionMaterial;
    legs.open = openMegaSession;
  }
}

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

  // Single-flight: concurrent cold callers share one resume. The promise is
  // removed as soon as it settles, so a FAILED resume is always retried by
  // the next caller (never memoized).
  const f = inflight();
  let storage: Storage;
  const pending = f.get(accountId);
  if (pending) {
    storage = await pending;
  } else {
    const resume = (async () => {
      let material: MegaSessionMaterial;
      try {
        material = JSON.parse(legs.decrypt(encryptedSession).toString('utf8')) as MegaSessionMaterial;
      } catch {
        throw new MegaError('session-expired', 'Stored MEGA session could not be decrypted');
      }
      if (!legs.validate(material)) {
        throw new MegaError('session-expired', 'Stored MEGA session is malformed');
      }
      return legs.open(material);
    })().finally(() => {
      if (f.get(accountId) === resume) f.delete(accountId);
    });
    f.set(accountId, resume);
    storage = await resume;
  }
  c.set(accountId, { storage, openedAt: Date.now() });
  return fn(storage);
}

/** Evict one account (after disconnect / reauth / a dead session). */
export function evictMegaSession(accountId: number): void {
  inflight().delete(accountId);
  const entry = cache().get(accountId);
  if (entry) {
    cache().delete(accountId);
    closeMegaSession(entry.storage);
  }
}

/** Evict everything (shutdown / test isolation). */
export function evictAllMegaSessions(): void {
  inflight().clear();
  for (const id of [...cache().keys()]) evictMegaSession(id);
}
