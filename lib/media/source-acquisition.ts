/**
 * Resumable MEGA source acquisition (Phase 1: acquisition only, no seek changes).
 *
 * Model: ONE sequential frontier per video. The decrypted source prefix
 * `<videoId>.ts.part` grows 0 -> SIZE across bounded resume attempts. A crash-
 * safe atomic manifest `<videoId>.ts.frontier.json` records the frontier, but
 * the FILE LENGTH is always the truth: we never claim more than exists, and
 * resume requests start at the actual file length (never at 0 once bytes
 * exist, never beyond what is on disk).
 *
 * Safety rules:
 * - manifest writes are atomic (tmp + rename) and happen only AFTER the
 *   corresponding bytes are durable on disk (write + fsync first);
 * - the manifest may LAG the file (safe: resume re-derives from stat);
 * - the manifest must NEVER LEAD the file (never advance it speculatively);
 * - identity (megaNodeId + sourceSize) mismatch discards the prefix;
 * - oversize/corrupt state is truncated or discarded, never served;
 * - resume ranges honour MEGA's 16-byte CTR alignment (floor + skip);
 * - bounded attempts + backoff, no infinite loops, no parallel fan-out.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Cache dir resolution duplicated from remux.ts on purpose: this module is
 * imported BY remux.ts, so importing mediaCacheDir back would be a cycle.
 * Keep the two in sync (both honour MEDIA_CACHE_DIR).
 */
function acquisitionCacheDir(): string {
  const override = process.env.MEDIA_CACHE_DIR;
  if (override && override.length > 0) return override;
  return path.join(process.cwd(), 'data', 'cache-media');
}

export interface SourceFrontier {
  videoId: number;
  megaNodeId: string;
  sourceSize: number;
  /** Durable plaintext prefix length in bytes (<= sourceSize). */
  frontier: number;
  updatedAt: string;
}

/** Max FETCH iterations per job (initial attempt + resumes). Bounded, no infinite loop. */
export const MAX_SOURCE_FETCH_ATTEMPTS = 6;

/** Env-overridable attempt bound (tests + ops; clamped to a sane range). */
export function maxSourceFetchAttempts(): number {
  const raw = Number(process.env.MEDIA_SOURCE_MAX_ATTEMPTS);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 50) return raw;
  return MAX_SOURCE_FETCH_ATTEMPTS;
}

/** Backoff between resume attempts (ms). Index 0 = after 1st failure. */
const RESUME_BACKOFF_MS = [800, 2000, 5000, 10_000, 15_000];

export function resumeBackoffMs(failureCount: number): number {
  const fixed = Number(process.env.MEDIA_RESUME_BACKOFF_MS);
  if (Number.isFinite(fixed) && fixed >= 0) return fixed;
  if (failureCount <= 0) return RESUME_BACKOFF_MS[0] ?? 800;
  const idx = Math.min(failureCount - 1, RESUME_BACKOFF_MS.length - 1);
  return RESUME_BACKOFF_MS[idx] ?? 15_000;
}

/** MEGA CTR decryption requires 16-byte-aligned start offsets. */
export function alignDown16(n: number): number {
  return n - (n % 16);
}

export function tsPartPath(videoId: number): string {
  return path.join(acquisitionCacheDir(), `${videoId}.ts.part`);
}

export function frontierManifestPath(videoId: number): string {
  return path.join(acquisitionCacheDir(), `${videoId}.ts.frontier.json`);
}

function isValidManifest(value: unknown): value is SourceFrontier {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.videoId === 'number' &&
    Number.isInteger(v.videoId) &&
    v.videoId >= 0 &&
    typeof v.megaNodeId === 'string' &&
    v.megaNodeId.length > 0 &&
    typeof v.sourceSize === 'number' &&
    Number.isInteger(v.sourceSize) &&
    v.sourceSize > 0 &&
    typeof v.frontier === 'number' &&
    Number.isInteger(v.frontier) &&
    v.frontier >= 0 &&
    typeof v.updatedAt === 'string'
  );
}

export async function loadSourceFrontier(videoId: number): Promise<SourceFrontier | null> {
  try {
    const raw = await fs.promises.readFile(frontierManifestPath(videoId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isValidManifest(parsed)) return null;
    if (parsed.videoId !== videoId) return null;
    if (parsed.frontier > parsed.sourceSize) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomically persist the frontier. Call ONLY after the corresponding bytes
 * are durable (written + fsynced). Never advances speculatively.
 */
export async function storeSourceFrontierAtomic(value: SourceFrontier): Promise<void> {
  const target = frontierManifestPath(value.videoId);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.promises.writeFile(
    tmp,
    JSON.stringify({ ...value, updatedAt: new Date().toISOString() }),
  );
  await fs.promises.rename(tmp, target);
}

export async function removeSourceFrontier(videoId: number): Promise<void> {
  await fs.promises.rm(frontierManifestPath(videoId), { force: true });
  await fs.promises.rm(`${frontierManifestPath(videoId)}.${process.pid}.tmp`, { force: true });
}

/**
 * Reconcile on-disk prefix state against identity. Returns the trustworthy
 * frontier (bytes that actually exist and may be resumed from).
 *
 * - identity mismatch (node/size) -> discard prefix + manifest, frontier 0;
 * - file longer than source -> truncate to source, frontier = source;
 * - manifest missing/corrupt but file plausible -> adopt file length, rewrite
 *   manifest (crash-recovery self-heal);
 * - manifest ahead of file (crashed between manifest + data, or manual edit)
 *   -> trust the FILE (min), rewrite manifest down;
 * - manifest behind file -> adopt file length, rewrite manifest up.
 */
export async function reconcileSourcePrefix(
  videoId: number,
  megaNodeId: string,
  sourceSize: number,
): Promise<{ frontier: number; resumed: boolean }> {
  const part = tsPartPath(videoId);
  let fileLen = 0;
  let fileExists = false;
  try {
    const stat = await fs.promises.stat(part);
    if (stat.isFile()) {
      fileExists = true;
      fileLen = stat.size;
    }
  } catch {
    fileExists = false;
    fileLen = 0;
  }
  const manifest = await loadSourceFrontier(videoId);
  if (manifest && (manifest.megaNodeId !== megaNodeId || manifest.sourceSize !== sourceSize)) {
    // New content under the same id: the old prefix belongs to someone else.
    await fs.promises.rm(part, { force: true });
    await removeSourceFrontier(videoId);
    return { frontier: 0, resumed: false };
  }
  if (!fileExists || fileLen === 0) {
    if (fileExists) {
      await fs.promises.rm(part, { force: true });
    }
    if (manifest && manifest.frontier !== 0) {
      await storeSourceFrontierAtomic({ videoId, megaNodeId, sourceSize, frontier: 0, updatedAt: '' });
    }
    return { frontier: 0, resumed: false };
  }
  if (fileLen > sourceSize) {
    // Impossible state: truncate to the known source length.
    try {
      const fh = await fs.promises.open(part, 'r+');
      try {
        await fh.truncate(sourceSize);
      } finally {
        await fh.close();
      }
    } catch {
      await fs.promises.rm(part, { force: true });
      await removeSourceFrontier(videoId);
      return { frontier: 0, resumed: false };
    }
    fileLen = sourceSize;
  }
  const frontier = fileLen;
  if (!manifest || manifest.frontier !== frontier) {
    try {
      await storeSourceFrontierAtomic({ videoId, megaNodeId, sourceSize, frontier, updatedAt: '' });
    } catch {
      // Best-effort: the file itself remains the truth; next reconcile heals.
    }
  }
  return { frontier, resumed: frontier > 0 };
}

/**
 * Derive the ciphertext range + decryptor parameters to continue from
 * `frontier`. MEGA CTR needs a 16-aligned start, so we re-request from the
 * floor and skip the overlap AFTER decryption (never before: the keystream
 * is positioned by decryptStart).
 */
export function resumeRequestParams(
  frontier: number,
  sourceSize: number,
): { rangeStart: number; decryptStart: number; skipBytes: number } {
  const clamped = Math.max(0, Math.min(frontier, sourceSize));
  const rangeStart = alignDown16(clamped);
  return { rangeStart, decryptStart: rangeStart, skipBytes: clamped - rangeStart };
}

/** Upstream HTTP statuses worth a fresh-URL resume (509 handled with backoff by callers). */
export function isResumeableUpstreamStatus(status: number): boolean {
  return status === 403 || status === 404 || status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/** Sleep that rejects early on abort (never sleeps past cancellation). */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
