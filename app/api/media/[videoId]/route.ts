import { NextRequest, NextResponse } from 'next/server';
import { Readable, Transform } from 'node:stream';
import { decrypt } from 'megajs';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/mega/envelope';
import { MegaError } from '@/lib/mega/account';
import { MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { markAccountReauthRequired } from '@/lib/megaAccounts';
import { withMegaSession, evictMegaSession } from '@/lib/sync/session-cache';
import { getTemporaryDownloadUrl } from '@/lib/mega/account';
import type { TemporaryDownloadUrl } from '@/lib/mega/account';
import { sniffMimeType } from '@/lib/mega/nodes';
import { getPrivateNodeMediaProperties } from '@/lib/mega/attributes';
import { keepAliveFetch, withTransientRetry, isTransientNetworkError } from '@/lib/net-resilience';
import {
  cancelLiveRemuxJob,
  canServeSeekFromSpool,
  createCachedFileResponse,
  createLiveResponse,
  decryptPrefixToBuffer,
  evictLiveRemuxJob,
  getOrCreateLiveRemuxJob,
  getRemuxSlotStats,
  hasLiveRemuxJob,
  joinLiveRemuxJob,
  MediaTempBudgetError,
  needsRemuxPlayback,
  nodeToWebSafe,
  noteSubscriberDetached,
  readRemuxCache,
  RemuxSlotUnavailableError,
  retainLiveRemuxJob,
  waitForLiveInit,
  waitForSpoolOffset,
} from '@/lib/media/remux';
import { touchRemuxCache, trackCacheStream } from '@/lib/media/cache';

// The media route uses node:stream, megajs CTR decryption and the Node-only
// network stack. Pin it to the Node.js runtime explicitly.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Lightweight in-process cache for short-lived MEGA temporary download URLs.
// URLs are valid for ~10 minutes; we cache for 5 minutes to avoid duplicate
// a=g calls for the same node across concurrent/repeated requests.
// ---------------------------------------------------------------------------

interface CachedDownloadUrl {
  url: string;
  size: number;
  expiresAt: number;
}

const downloadUrlCache = new Map<string, CachedDownloadUrl>();

/**
 * In-flight a=g requests per node (single-flight): concurrent cold requests
 * for the same video (player probe + main stream, or two tabs) must issue
 * ONE URL request, not one per request. Rejections are shared: every waiter
 * sees the same failure and the transient-retry wrapper re-issues it.
 */
const downloadUrlInflight = new Map<string, Promise<TemporaryDownloadUrl>>();

/**
 * Evict a cached download URL (transient-404 handling: a storage 404/403 may
 * mean a stale g-URL rather than a deleted node — retry once with a fresh
 * a=g URL instead of declaring the node gone). The in-flight entry is
 * cleared too so the retry cannot rejoin the same stale request.
 */
function evictCachedDownloadUrl(nodeId: string): void {
  downloadUrlCache.delete(nodeId);
  downloadUrlInflight.delete(nodeId);
}

async function getCachedDownloadUrl(
  nodeId: string,
  storage: unknown,
  fetcher: (storage: unknown, nodeId: string) => Promise<TemporaryDownloadUrl>,
): Promise<TemporaryDownloadUrl> {
  const cached = downloadUrlCache.get(nodeId);
  if (cached && cached.expiresAt > Date.now()) {
    return { url: cached.url, size: cached.size };
  }
  const existing = downloadUrlInflight.get(nodeId);
  if (existing) return existing;
  const pending = (async () => {
    const result = await fetcher(storage, nodeId);
    downloadUrlCache.set(nodeId, {
      url: result.url,
      size: result.size,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return result;
  })().finally(() => {
    downloadUrlInflight.delete(nodeId);
  });
  downloadUrlInflight.set(nodeId, pending);
  return pending;
}

/**
 * In-flight probe deduplication (P1.2): concurrent cold viewers for the
 * same video share ONE background probe instead of each firing an identical
 * MEGA fetch. Entries live only for the probe duration (deleted on settle),
 * so the map is self-cleaning and bounded by concurrent cold requests.
 * Keys are namespaced per probe kind (`fa8:<id>`, `layout:<id>`).
 */
const probeInflight = new Map<string, Promise<unknown>>();

function singleFlight<T>(key: string, supplier: () => Promise<T>): Promise<T> {
  const existing = probeInflight.get(key);
  if (existing) return existing as Promise<T>;
  const pending = supplier().finally(() => {
    if (probeInflight.get(key) === pending) probeInflight.delete(key);
  });
  probeInflight.set(key, pending);
  return pending;
}

/**
 * Persist a probed duration (P1.2): first valid probe wins, permanently.
 *
 * Validation: only finite positive whole seconds reach the DB (0/NaN/
 * Infinity/negative — e.g. fa:8's normalize can yield 0 — are dropped).
 * Idempotency: `updateMany` with `duration: null` in the predicate makes
 * concurrent first-writes race-safe (exactly one wins; losers are no-ops),
 * and no later probe ever overwrites a stored value. Fire-and-forget from
 * callers: the write never blocks playback, and a DB failure only logs.
 */
export function persistVideoDuration(videoId: number, seconds: number | null | undefined): void {
  if (seconds === null || seconds === undefined) return;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return;
  const whole = Math.round(seconds);
  if (!Number.isFinite(whole) || whole <= 0) return;
  prisma.video
    .updateMany({ where: { id: videoId, duration: null }, data: { duration: whole } })
    .then((r) => {
      if (r.count === 1) console.log(`[media] persisted probe duration video ${videoId}: ${whole}s`);
    })
    .catch(() => {
      // Background best-effort: a failed write must never break playback.
    });
}
/** Negative result cache for the container sniff (nodeId:size -> expiry);
 * a mislabeled file is persisted to the DB on first detection instead. */
const containerSniffCache = new Map<string, number>();
const CONTAINER_SNIFF_TTL_MS = 10 * 60_000;

function sniffCacheKey(nodeId: string, size: number): string {
  return `${nodeId}:${size}`;
}

/**
 * Minimal TS-as-MP4 routing probe (P0 C4 slice): fetch + decrypt just the
 * first 188 bytes and sniff the container. Returns 'video/mp2t' when the
 * bytes are actually MPEG-TS despite an MP4 label, else null (real MP4,
 * unknown, or any failure — caller keeps the direct path, never worse).
 * Single attempt, bounded by the request signal; never throws.
 */
async function sniffRemuxContainer(
  nodeId: string,
  fileKey: Buffer,
  upstreamUrl: string,
  size: number,
  fetchImpl: (url: string, signal?: AbortSignal) => Promise<Response>,
  signal: AbortSignal | undefined,
): Promise<'video/mp2t' | null> {
  try {
    const key = sniffCacheKey(nodeId, size);
    const hit = containerSniffCache.get(key);
    if (hit !== undefined && hit > Date.now()) return null;
    const res = await fetchImpl(`${upstreamUrl}/0-187`, signal);
    if (!res.ok || !res.body) return null;
    const cipher = Buffer.from(await res.arrayBuffer());
    if (cipher.length < 188) return null;
    const plain = await decryptPrefixToBuffer(fileKey, cipher);
    const detected = sniffMimeType(plain);
    if (detected === 'video/mp2t') return 'video/mp2t';
    containerSniffCache.set(key, Date.now() + CONTAINER_SNIFF_TTL_MS);
    return null;
  } catch {
    return null;
  }
}
/**
 * MP4s at or above this size are considered for local caching (Bug 5).
 * Smaller files are cheap enough to stream through MEGA directly; caching
 * them would double storage for little latency gain.
 */
const MP4_CACHE_MIN_SIZE = 100 * 1024 * 1024;

/**
 * True when an MP4 source is a candidate for the local disk cache (Bug 5):
 * only large files qualify; small/faststart MP4s keep the direct stream
 * path with zero extra work.
 */
function isCacheableMp4(mimeType: string, size: number): boolean {
  return mimeType === 'video/mp4' && size >= MP4_CACHE_MIN_SIZE;
}

/**
 * Layout probe for a large cached MP4 (Bug 5): is the moov atom NOT in the
 * first few hundred KB? Such files are non-faststart: every playback start
 * (and many seeks) needs a MEGA range near the END of the file to read the
 * index, which is exactly the expensive pattern the local cache removes.
 * The check reads ~256 KB from the start over the same short-lived URL the
 * playback request resolved (no extra session/URL generation), decrypts it
 * through megajs and walks the top-level boxes. Any doubt -> null (caller
 * keeps the direct path; never worse than today).
 */
async function probeMp4Layout(
  fileKey: Buffer,
  upstreamUrl: string,
  size: number,
  fetchImpl: (url: string, signal?: AbortSignal) => Promise<Response>,
  signal?: AbortSignal,
): Promise<'faststart' | 'non-faststart' | null> {
  try {
    const PROBE_BYTES = Math.min(256 * 1024, size);
    const res = await fetchImpl(`${upstreamUrl}/0-${PROBE_BYTES - 1}`, signal);
    if (!res.ok || !res.body) return null;
    const cipher = Buffer.from(await res.arrayBuffer());
    const plain = await decryptPrefixToBuffer(fileKey, cipher);
    // Walk top-level boxes: mdat BEFORE moov -> non-faststart.
    let off = 0;
    let sawMoov = false;
    for (;;) {
      if (off + 8 > plain.length) break;
      const boxSize = plain.readUInt32BE(off);
      const type = plain.toString('latin1', off + 4, off + 8);
      if (boxSize === 1) {
        // 64-bit size (large mdat): read the 64-bit width.
        if (off + 16 > plain.length) break;
        const hi = plain.readUInt32BE(off + 8);
        const lo = plain.readUInt32BE(off + 12);
        const big = hi * 2 ** 32 + lo;
        if (type === 'mdat') return sawMoov ? 'faststart' : 'non-faststart';
        off += big;
        continue;
      }
      if (boxSize < 8) break; // malformed/unknown - be conservative
      if (type === 'moov') { sawMoov = true; break; }
      if (type === 'mdat') return sawMoov ? 'faststart' : 'non-faststart';
      off += boxSize;
    }
    return sawMoov ? 'faststart' : null;
  } catch {
    return null;
  }
}

/**
 * Bounds for the cold remux path so a slow/hung MEGA response can never
 * leave the browser at 0:00 with an indefinite spinner:
 *  - PREFLIGHT: how long to wait for the upstream headers (509/404/403
 *    detection) and the first live init bytes before falling back to serving
 *    media bytes directly (P0: the browser must never receive a JSON body on
 *    a media request just because MEGA is slow — JSON is reserved for
 *    genuinely unrecoverable states: auth failure, deleted node, or a
 *    timeout with zero playable bytes).
 *  - CACHE_WAIT: how long a cold SEEK waits for the faststart cache
 *    (full download + stream-copy remux) before falling back to the live
 *    spool window.
 */
const MEDIA_PREFLIGHT_TIMEOUT_MS = 20_000;
const MEDIA_CACHE_WAIT_TIMEOUT_MS = 45_000;
/**
 * One extra attempt for transient-looking upstream HTTP statuses (P0: a
 * historical 404/ENOENT burst self-resolved minutes later, so a lone
 * storage 404/403/5xx is retried once after a short backoff; a second
 * failure is treated as genuinely unavailable). Auth/session states are
 * classified separately and never reach this path.
 */
const UPSTREAM_STATUS_RETRIES = 1;
const UPSTREAM_STATUS_BACKOFF_MS = 800;

/**
 * Private MEGA video streaming (owner only).
 *
 * How a private video reaches the player:
 *   1. the browser (with the website session cookie) requests this URL;
 *   2. the server verifies the requesting user OWNS the video's MEGA account;
 *   3. the stored (encrypted) MEGA session is resumed - no password needed;
 *   4. the API is asked (a=g) for a SHORT-LIVED download URL for the node.
 *      That URL is unguessable, carries no credentials, and expires in ~10
 *      minutes;
 *   5. the ciphertext bytes are streamed from MEGA's storage servers and
 *      decrypted on the server (AES-128-CTR, MEGA's file format) before being
 *      sent to the browser.
 *
 * The browser never sees MEGA session material, the master key, or the file
 * key. HTTP Range requests are supported for seeking.
 */

function parseRange(range: string | null, size: number): { start: number; end: number } | null | 'invalid' {
  if (!range) return null; // full resource
  const m = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] === '') return 'invalid';
  if (m[1] === '') {
    // suffix range: last N bytes
    const suffix = Number(m[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Number(m[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'invalid';
  if (start < 0 || end < start) return 'invalid';
  if (start >= size) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

/**
 * Throw an AbortError when the viewer went away. Checked at points in the
 * live section where no other abort plumbing exists (preflight loop,
 * response creation): a request that died mid-preflight must surface as a
 * quiet 499 via the outer catch — never proceed to serve a dead viewer,
 * and never leave interest that isn't cleaned up by the section finally.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('viewer went away before the response was ready'), { name: 'AbortError' });
  }
}

/** Drop the first `n` bytes of a stream (n < 16 in our use case). */
function skipLeading(n: number): Transform {
  let remaining = n;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (remaining <= 0) return cb(null, chunk);
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        return cb(null);
      }
      const rest = chunk.subarray(remaining);
      remaining = 0;
      cb(null, rest);
    },
  });
}

/** Truncate a stream to exactly `n` bytes (drops any surplus tail). */
function limitBytes(n: number): Transform {
  let remaining = n;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (remaining <= 0) return cb(null);
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        return cb(null, chunk);
      }
      const head = chunk.subarray(0, remaining);
      remaining = 0;
      cb(null, head);
    },
  });
}

/**
 * Best-effort exact source duration via MEGA fa:8 media properties (tiny
 * metadata fetch - never downloads media). Null when the node has no media
 * attribute, the fetch fails, or the deps are fakes (unit tests). Never
 * throws.
 *
 * Bounded by MEGA_FA8_TIMEOUT_MS: the a=ufa + attribute-POST legs use raw
 * transports without their own timeout, and MEGA fa:8 is observed to fail
 * persistently (ETEMPUNAVAIL) - an unbounded background fetch would hold a
 * socket and a log-worthy failure forever for zero benefit.
 */
const MEGA_FA8_TIMEOUT_MS = 5_000;

async function fetchMegaDurationSeconds(
  storage: unknown,
  megaFa: string | null,
  fileKey: Buffer,
): Promise<number | null> {
  try {
    const api = (storage as { api?: { request?: unknown } })?.api;
    const request = api?.request as unknown as (
      cmd: Record<string, unknown>,
    ) => Promise<unknown>;
    if (typeof request !== 'function') return null;
    const pending = getPrivateNodeMediaProperties(
      { request: (cmd) => request.call(api, cmd) },
      megaFa,
      fileKey,
    );
    // The race loser keeps running: a late rejection after the timeout won
    // must not surface as an unhandled rejection.
    pending.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fa:8 timeout')), MEGA_FA8_TIMEOUT_MS);
      if (typeof timer === 'object' && typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
        (timer as unknown as { unref(): void }).unref();
      }
    });
    const media = await Promise.race([pending, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return media?.durationSeconds ?? null;
  } catch {
    return null;
  }
}

/**
 * Injectable MEGA boundary (mirrors the sync worker's SyncDeps pattern) so
 * unit tests can exercise the full handler with a fake download URL and fake
 * ciphertext without touching the real MEGA network.
 */
export interface MediaDeps {
  /** Run fn with a live MEGA session (default: resume from stored material). */
  withMegaSession: typeof withMegaSession;
  /** Resolve a short-lived download URL (+ size) for a node. */
  getDownloadUrl: (storage: unknown, nodeId: string) => Promise<TemporaryDownloadUrl>;
  /** Fetch ciphertext bytes from MEGA storage (range embedded in the URL). */
  fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>;
}

const defaultMediaDeps: MediaDeps = {
  withMegaSession,
  getDownloadUrl: (storage, nodeId) => getTemporaryDownloadUrl(storage as Parameters<typeof getTemporaryDownloadUrl>[0], nodeId),
  fetchCiphertext: (url, signal) => keepAliveFetch(url, { signal }),
};

/**
 * Safe per-request context for diagnostics. Logged fields are limited to:
 * video db id, MEGA node handle (a public-ish opaque handle, not a key),
 * the requested plaintext range, upstream status/error CLASS, elapsed time,
 * and retry attempt. NEVER: session id, master/file keys, signed URLs.
 */
function mediaLogContext(videoId: number, nodeId: string | null, rangeHeader: string | null) {
  const startedAt = Date.now();
  return {
    elapsedMs: () => Date.now() - startedAt,
    safeFields: () => ({ videoId, node: nodeId ?? 'unknown', range: rangeHeader ?? 'none' }),
  };
}

/**
 * Fetch ciphertext with bounded retry for transient connect failures.
 * The exact same storage URL is retried, so Range semantics are identical
 * on every attempt. Abort (client gone) is never retried.
 */
async function fetchCiphertextWithRetry(
  url: string,
  signal: AbortSignal | undefined,
  log: ReturnType<typeof mediaLogContext>,
  videoId: number,
  fetchImpl: (url: string, signal?: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const attempt0 = { attempt: 0 };
  return withTransientRetry(
    () => {
      attempt0.attempt += 1;
      return fetchImpl(url, signal);
    },
    {
      attempts: 3,
      isTransient: (err) => {
        if (signal?.aborted) return false;
        const ok = isTransientNetworkError(err);
        if (!ok) return false;
        console.warn(
          `[media] video ${videoId} transient upstream error (attempt ${attempt0.attempt}, elapsed ${log.elapsedMs()}ms, range ${log.safeFields().range})`,
        );
        return true;
      },
    },
  );
}

/**
 * Core handler. `rawUserId` is the authenticated website user id (null when
 * unauthenticated). Split out of the route wrapper so tests can drive it
 * without next/headers request scope; behavior is identical.
 */
export async function handleMediaRequest(
  rawUserId: string | null,
  videoIdParam: string,
  requestHeaders: Headers,
  signal: AbortSignal,
  deps: MediaDeps = defaultMediaDeps,
  method = 'GET',
): Promise<Response> {
  if (!rawUserId) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const videoId = Number(videoIdParam);
  if (!Number.isInteger(videoId) || videoId <= 0) {
    return NextResponse.json({ error: 'Invalid video id.' }, { status: 400 });
  }

  const video = await prisma.video.findFirst({
    where: { id: videoId, megaAccountId: { not: null } },
    include: { megaAccount: { select: { id: true, userId: true, status: true, encryptedSession: true } } },
  });

  // Ownership is enforced here (and in the data layer): a missing row, a
  // public row, or a row belonging to someone else all answer identically.
  if (!video || !video.megaAccount || video.megaAccount.userId !== rawUserId) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
  }

  if (!video.megaNodeId || !video.fileKeyEncrypted) {
    return NextResponse.json({ error: 'This video is not playable yet.' }, { status: 409 });
  }

  // Safe diagnostics context (no secrets - see mediaLogContext).
  const logCtx = mediaLogContext(videoId, video.megaNodeId, requestHeaders.get('range'));

  const account = video.megaAccount;
  if (account.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
    return NextResponse.json(
      { error: 'The MEGA account for this video is disconnected.' },
      { status: 410 },
    );
  }
  if (account.status === MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED) {
    return NextResponse.json(
      { error: 'This video needs its MEGA account reconnected before it can play.' },
      { status: 409 },
    );
  }

  // Decrypt the per-node file key (envelope key from the environment).
  let fileKey: Buffer;
  try {
    fileKey = decryptSecret(video.fileKeyEncrypted);
  } catch {
    return NextResponse.json({ error: 'Stored playback key is unreadable.' }, { status: 500 });
  }

  // HEAD probes must never touch MEGA: answer from stored metadata only.
  if (method === 'HEAD') {
    const contentType = needsRemuxPlayback(video.mimeType) ? 'video/mp4' : (video.mimeType ?? 'video/mp4');
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    });
  }

  try {
    // Cache decision BEFORE any MEGA work (P0 order preserved):
    //  - MPEG-TS always remuxes; a warm cache avoids session resume, a=g,
    //    MIME sniffing, and the source download entirely;
    //  - large MP4s are probed for a non-faststart layout (moov after the
    //    media) and cached too (Bug 5): playback of such files otherwise
    //    re-downloads big MEGA ranges on every start/seek. The probe needs a
    //    session + URL, so it deliberately runs AFTER this point's network
    //    step shares its result (see probeMp4Layout use below).
    const storedMimeType = video.mimeType ?? 'video/mp4';
    const cacheSize = video.fileSize !== null ? Number(video.fileSize) : null;
    if (cacheSize !== null && (needsRemuxPlayback(storedMimeType) || isCacheableMp4(storedMimeType, cacheSize))) {
      const warm = await readRemuxCache(video.id, video.megaNodeId, cacheSize);
      if (warm) {
        console.warn(`[media] cache hit video ${videoId} path=warm-cache`);
        const warmRange = parseRange(requestHeaders.get('range'), warm.size);
        if (warmRange === 'invalid') {
          return new NextResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${warm.size}` },
          });
        }
        const rs = warmRange ? warmRange.start : 0;
        const re = warmRange ? warmRange.end : warm.size - 1;
        // P1.5: protect the file while streamed + record the access for LRU.
        // The touch is fire-and-forget (throttled); serving never waits.
        const release = trackCacheStream(video.id);
        void touchRemuxCache(video.id);
        return createCachedFileResponse(warm.path, rs, re, warm.size, signal, release);
      }
      if (needsRemuxPlayback(storedMimeType)) {
        console.warn(`[media] cache miss video ${videoId} path=cold`);
      }
    }

    // The download-URL step (session resume + read-only a=g) intermittently
    // fails with transient MEGA/network errors (observed live as a lone
    // 503 while the retry-less request died). Retry TRANSIENT failures only:
    // session-expired/auth/mfa MegaErrors are never retried, so the 409
    // reauth contract is unchanged.
    //
    // Startup-latency rule: NOTHING optional may serialize before the a=g
    // URL - the live job (and therefore first byte) cannot be created until
    // this returns. The fa:8 media-properties duration probe is therefore
    // fired in the BACKGROUND (never awaited): it usually fails anyway
    // (ETEMPUNAVAIL), and for MPEG-TS the authoritative duration comes from
    // the background PCR probe inside the live job. When fa:8 does land it
    // is persisted once (first-wins) for future plays. Videos whose duration
    // is already known skip the fa:8 call entirely; concurrent cold viewers
    // share one in-flight probe via singleFlight.
    const { upstreamUrl, size, durationSeconds } = await withTransientRetry(
      () =>
        deps.withMegaSession(
          account.id,
          account.encryptedSession,
          async (storage) => {
            if (video.duration == null) {
              void singleFlight(`fa8:${video.id}`, () =>
                fetchMegaDurationSeconds(storage, video.megaFa, fileKey).then((secs) => {
                  persistVideoDuration(video.id, secs);
                  return secs;
                }),
              ).catch(() => {
                // Background best-effort: failures change nothing.
              });
            }
            const resolvedDl = await getCachedDownloadUrl(video.megaNodeId!, storage, deps.getDownloadUrl);
            const size =
              resolvedDl.size ?? (video.fileSize !== null ? Number(video.fileSize) : null);
            return { upstreamUrl: resolvedDl.url, size, durationSeconds: video.duration };
          },
        ),
      {
        attempts: 2,
        isTransient: (err) =>
          (err instanceof MegaError && err.kind === 'transient') ||
          isTransientNetworkError(err),
      },
    );

    if (size === null || !Number.isFinite(size) || size < 0) {
      return NextResponse.json(
        { error: 'File size unknown to MEGA right now.' },
        { status: 502 },
      );
    }

    const rangeHeader = requestHeaders.get('range');
    // Re-parse range now that size is known.
    //
    // P0-C: `size` here is the SOURCE (MEGA/TS) size, so a verdict of
    // 'invalid' is only authoritative for representations that ARE the
    // source bytes (the direct path). A live fMP4 remux has its own
    // (initially unknown) length, so a syntactically valid Range that is
    // unsatisfiable against the source size must NOT 416 here — the remux
    // branch decides in spool coordinates. Only a malformed Range 416s
    // up front.
    const resolvedRange = parseRange(rangeHeader, size);
    const rangeSyntaxOk =
      rangeHeader == null || /^bytes=(\d+-\d*|-\d+)$/.test(rangeHeader);
    if (resolvedRange === 'invalid' && !rangeSyntaxOk) {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    const resolvedStart = resolvedRange && resolvedRange !== 'invalid' ? resolvedRange.start : 0;
    const resolvedEnd = resolvedRange && resolvedRange !== 'invalid' ? resolvedRange.end : size - 1;

    const apiStart = resolvedStart - (resolvedStart % 16);
    const skipBytes = resolvedStart - apiStart;

    // Container truth check: an `.mp4`-labeled file may actually be MPEG-TS
    // (verified live: 627/631 serve 0x47 sync bytes while labeled
    // video/mp4). Browsers park at 0:00 on such bytes, so sniff the first
    // 188 B and route TS-as-MP4 into the remux pipeline. Only MP4-labeled
    // GETs pay this single tiny fetch (already-remux types and warm-cache
    // hits skip it; a negative result is mem-cached for 10 min); any doubt
    // or failure keeps the direct path, never worse than today. A positive
    // is persisted so later plays route without re-sniffing.
    let effectiveMimeType = storedMimeType;
    if (
      method === 'GET' &&
      !needsRemuxPlayback(effectiveMimeType) &&
      (!effectiveMimeType || effectiveMimeType === 'video/mp4')
    ) {
      const probed = await sniffRemuxContainer(
        video.megaNodeId!,
        fileKey,
        upstreamUrl,
        size,
        deps.fetchCiphertext,
        signal,
      );
      if (probed) {
        console.warn(`[media] video ${videoId} labeled ${effectiveMimeType} but bytes are ${probed} -> remux pipeline`);
        effectiveMimeType = probed;
        await prisma.video
          .update({ where: { id: video.id }, data: { mimeType: probed } })
          .catch(() => {});
      }
    }

    // MPEG-TS sources cannot play in browsers as-is, but ours carry
    // browser-compatible h264 + AAC streams (verified with ffprobe), so a
    // stream-copy remux to MP4 makes them genuinely playable:
    //   - warm cache  -> faststart MP4 with full Range support (duration +
    //     seeking), exactly like a direct MP4;
    //   - cold cache, initial request (start 0) -> LIVE fragmented-MP4
    //     stream: playback starts within seconds while the same download
    //     simultaneously warms the faststart cache underneath (refresh and
    //     later seeks then get full features). Waiting for the whole file
    //     first left the player at 0:00 for minutes on large sources.
    //   - cold cache, seek (start > 0) -> served from the live spool window
    //     when possible (Bug 2); otherwise bounded-wait for the cache.
    // Large NON-faststart MP4s join the same pipeline (Bug 5): their moov
    // sits at the end, so direct streaming re-fetches expensive MEGA ranges
    // on every start/seek; a one-time stream-copy cache fixes repeat plays.
    // No re-encoding anywhere (-c copy), and only the muxer differs (faststart
    // file vs live fMP4) - direct MP4 playback itself is untouched.
    const needsRemux = needsRemuxPlayback(effectiveMimeType);
    // P0: NO blocking faststart probe. The two-range layout probe used to
    // serialize BEFORE the first media byte (2+ MEGA round-trips of pure
    // startup latency → browser abort/re-request spiral). The fMP4 pipeline
    // handles either layout; the probe is deferred: kick a background
    // cache-warm for large MP4s whose layout is unknown so the NEXT play is
    // a warm-cache hit, and serve THIS request direct immediately (byte-exact
    // MEGA bytes — correct for faststart AND moov-at-end alike; the browser
    // simply fetches the moov range itself when needed).
    // P1.2: a persisted layout verdict is reused without re-probing (the
    // stored row is trusted only while its fileSize still matches the fresh
    // MEGA size; a size change means new content, so the verdict is stale).
    // - known faststart  -> skip the probe entirely (nothing to warm);
    // - known non-faststart -> warm directly (no probe fetch);
    // - unknown           -> probe once (single-flight across concurrent
    //   viewers), persist the verdict, warm when non-faststart.
    const layoutSizeMatches = video.fileSize !== null && Number(video.fileSize) === size;
    const knownLayout = layoutSizeMatches ? video.mp4Faststart : null;
    // Fire-and-forget faststart-cache warm for a large non-faststart MP4.
    // This request is already streaming direct and must not wait; the live
    // job is itself single-flight per video, so concurrent warms coalesce.
    // The warm holds a retained (non-viewer) subscriber so the
    // zero-subscriber grace logic leaves server-initiated warming alone;
    // it is released when the job settles (cache still carries the outcome).
    //
    // Resumable acquisition (Phase 1): the job can ask for a FRESH download
    // URL/session when its in-flight URL stalls or expires mid-download.
    // The resolver bypasses the 5-minute g-URL cache (the cached URL may be
    // the stale one) and resumes the stored session. Called only on the
    // failure path — never for videos that acquire normally.
    const refreshUpstreamUrl = async (): Promise<string> => {
      evictCachedDownloadUrl(video.megaNodeId!);
      const fresh = await deps.withMegaSession(
        account.id,
        account.encryptedSession,
        async (storage) => getCachedDownloadUrl(video.megaNodeId!, storage, deps.getDownloadUrl),
      );
      return fresh.url;
    };
    const kickCacheWarm = () => {
      try {
        const warmJob = getOrCreateLiveRemuxJob({
          videoId: video.id,
          megaNodeId: video.megaNodeId,
          upstreamUrl,
          fileKey,
          size,
          durationSeconds: video.duration,
          onDurationKnown: (secs: number) => {
            persistVideoDuration(video.id, secs);
          },
          fetchCiphertext: (url, signal) =>
            fetchCiphertextWithRetry(url, signal, logCtx, videoId, deps.fetchCiphertext),
          refreshUpstreamUrl,
        });
        const release = retainLiveRemuxJob(warmJob);
        warmJob.cache.then(
          () => release(),
          () => release(),
        );
      } catch {
        // Warm failure is non-fatal; direct serve continues.
      }
    };
    if (
      !needsRemux &&
      method === 'GET' &&
      isCacheableMp4(effectiveMimeType, size) &&
      layoutSizeMatches
    ) {
      if (knownLayout === true) {
        // Confirmed faststart: nothing to warm, no probe.
      } else if (knownLayout === false) {
        // Confirmed non-faststart: warm the faststart cache for repeat
        // plays without spending a probe fetch.
        console.warn(`[media] video ${videoId} known non-faststart MP4 -> background cache warm`);
        kickCacheWarm();
      } else {
        void singleFlight(`layout:${video.id}`, () =>
          probeMp4Layout(fileKey, upstreamUrl, size, deps.fetchCiphertext, undefined),
        )
          .then((layout) => {
            if (layout === null) return; // doubt -> nothing persisted, direct stands
            // Persist the verdict (size-gated at read time, so a later
            // content change re-probes instead of trusting this).
            prisma.video
              .update({ where: { id: video.id }, data: { mp4Faststart: layout === 'faststart' } })
              .catch(() => {});
            if (layout !== 'non-faststart') return;
            // Moov-at-end confirmed in the background: warm the faststart
            // cache so repeat plays/seeks are local. Fire-and-forget — this
            // request is already streaming direct and must not wait.
            console.warn(`[media] video ${videoId} large non-faststart MP4 -> background cache warm`);
            kickCacheWarm();
          })
          .catch(() => {
            // Probe failure is non-fatal; direct serve continues.
          });
      }
    }
    if (needsRemux) {
      const warm = await readRemuxCache(video.id, video.megaNodeId, size);
      if (warm) {
        const warmRange = parseRange(rangeHeader, warm.size);
        if (warmRange === 'invalid') {
          return new NextResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${warm.size}` },
          });
        }
        const rs = warmRange ? warmRange.start : 0;
        const re = warmRange ? warmRange.end : warm.size - 1;
        // P1.5: protect the file while streamed + record the access for LRU.
        const release = trackCacheStream(video.id);
        void touchRemuxCache(video.id);
        return createCachedFileResponse(warm.path, rs, re, warm.size, signal, release);
      }
      // Server-owned pipeline: runs to completion even if this viewer goes
      // away, so a refresh finds a warm cache. No viewer abort signal is
      // passed - stalls are bounded by the upstream fetch timeouts.
      //
      // P0 SLOT FIX: when the pool is saturated and no job exists for this
      // video, fail fast with a retryable 503 instead of queueing (unbounded)
      // and then timing out anyway. An existing job is always joined — its
      // slot is already held and its bytes are already warming.
      const existed = hasLiveRemuxJob(video.id);
      if (!existed) {
        const slots = getRemuxSlotStats();
        if (slots.active >= slots.max) {
          console.warn(
            `[media] video ${videoId} remux pool saturated (active=${slots.active} queued=${slots.queued}) -> 503 fast`,
          );
          return NextResponse.json(
            { error: 'The video is still being prepared; please retry in a moment.' },
            { status: 503, headers: { 'Retry-After': '5' } },
          );
        }
      }
      let job0;
      try {
        job0 = getOrCreateLiveRemuxJob({
          videoId: video.id,
          megaNodeId: video.megaNodeId,
          size,
          fileKey,
          upstreamUrl,
          durationSeconds,
          onDurationKnown: (secs) => {
            // Gate on the request-start snapshot (cheap); first-wins inside
            // persistVideoDuration makes concurrent landings race-safe.
            if (video.duration == null) persistVideoDuration(video.id, secs);
          },
          // Forward the job abort signal so zero-subscriber cancellation
          // stops the MEGA download promptly (fetchCiphertextWithRetry
          // never retries an aborted request).
          fetchCiphertext: (url, signal) =>
            fetchCiphertextWithRetry(url, signal, logCtx, videoId, deps.fetchCiphertext),
          refreshUpstreamUrl,
        });
      } catch (err) {
        // P1-C: temp-budget/disk admission failed before any work started
        // (nothing registered, nothing warmed): retryable 503, never 502.
        if (err instanceof MediaTempBudgetError) {
          console.warn(`[media] video ${videoId} temp budget exhausted -> 503 fast`);
          return NextResponse.json(
            { error: 'The video is still being prepared; please retry in a moment.' },
            { status: 503, headers: { 'Retry-After': '5' } },
          );
        }
        throw err;
      }
      if (!existed) {
        console.warn(`[media] new remux job video ${videoId} size=${size}`);
      } else {
        joinLiveRemuxJob(videoId);
        console.warn(`[media] joined remux job video ${videoId} joined=${job0.xJoinedCount}`);
      }
      // `job` is reassignable: the transient-404 retry below evicts the dead
      // job and swaps in a fresh one against a new URL.
      let job = job0;
      try {
        // Preflight: the upstream may answer 509 (MEGA bandwidth quota) or a
        // PERSISTENT 404/403 (node genuinely gone). Report those as honest
        // JSON BEFORE response headers go out - after that point only a doomed
        // stream is possible.
        //
        // P0 FAILURE-POLICY FIX: a TRANSIENT upstream 404/403 (stale g-URL,
        // storage hiccup — observed live as a lone 404 burst that self-resolved
        // minutes later) is retried ONCE with a FRESH download URL before the
        // node is declared gone, so a passing storage glitch never becomes a
        // permanent-looking 410. Only a repeated failure answers 410.
        //
        // Bounded: job.ready resolves when the full-file MEGA fetch returns
        // headers, which can take many seconds (MEGA transient) or never on a
        // hung socket. An unbounded await left the browser at 0:00 with an
        // indefinite spinner. We timebox it; on timeout the job keeps warming
        // in the background (a refresh then succeeds). A slot-saturated job
        // (RemuxSlotUnavailableError) answers a retryable 503 immediately.
        let preflightErr: unknown = null;
        for (let attempt = 0; attempt <= UPSTREAM_STATUS_RETRIES; attempt++) {
          try {
            // A viewer that went away mid-preflight must not proceed to
            // serve a dead response (its subscriber could never detach).
            // Throws AbortError -> quiet 499 via the outer catch.
            throwIfAborted(signal);
            console.warn(`[route] video ${videoId} awaiting job.ready (start=${resolvedStart} end=${resolvedEnd}) at +${logCtx.elapsedMs()}ms`);
            await Promise.race([
              job.ready,
              new Promise<never>((_resolve, reject) =>
                setTimeout(
                  () =>
                    reject(
                      Object.assign(new Error('MEGA is still preparing this video.'), {
                        name: 'MediaPreflightTimeout',
                      }),
                    ),
                  MEDIA_PREFLIGHT_TIMEOUT_MS,
                ),
              ),
            ]);
            preflightErr = null;
            break;
          } catch (err) {
            // A viewer that went away stays gone: rethrow so the outer
            // catch answers a quiet 499 instead of converting this into a
            // misleading 503 for a dead request.
            if (err instanceof Error && err.name === 'AbortError') throw err;
            preflightErr = err;
            const st = (err as { upstreamStatus?: unknown }).upstreamStatus;
            // Retryable-once: a storage 404/403 on the FIRST attempt only.
            // Anything else (509, timeout, slot exhaustion, unknown) breaks.
            if ((st === 404 || st === 403) && attempt < UPSTREAM_STATUS_RETRIES) {
              console.warn(
                `[media] video ${videoId} transient upstream ${st} (attempt ${attempt + 1}) — refreshing URL and retrying once`,
              );
              evictCachedDownloadUrl(video.megaNodeId!);
              await new Promise((r) => setTimeout(r, UPSTREAM_STATUS_BACKOFF_MS));
              // Re-resolve a fresh URL + recreate the job against it, so the
              // retry does not replay the same stale URL.
              try {
                const fresh = await deps.withMegaSession(
                  account.id,
                  account.encryptedSession,
                  async (storage) => getCachedDownloadUrl(video.megaNodeId!, storage, deps.getDownloadUrl),
                );
        // Swap to the retried job for the remainder of this request.
                // The stale job is evicted first so getOrCreateLiveRemuxJob
                // actually creates a fresh pipeline against the new URL (it
                // returns the existing job otherwise, replaying the stale URL).
                // The evicted job keeps its own lifecycle (its awaiters still
                // settle); it simply no longer blocks this video's slot in the
                // map, and its finally still releases its slot + temps.
                evictLiveRemuxJob(video.id, job);
                // Abort the superseded pipeline promptly: without this, the
                // old job would keep appending its stale-URL download to the
                // same ts.part while the new job resumes from a frontier the
                // old job is still moving (overlapping ranges -> duplicates).
                // The preserved prefix stays on disk; the new job adopts it.
                cancelLiveRemuxJob(job, 'superseded by fresh-URL retry');
                job = getOrCreateLiveRemuxJob({
                  videoId: video.id,
                  megaNodeId: video.megaNodeId,
                  size,
                  fileKey,
                  upstreamUrl: fresh.url,
                  durationSeconds,
                  onDurationKnown: (secs) => {
                    if (video.duration == null) persistVideoDuration(video.id, secs);
                  },
                  fetchCiphertext: (url, signal) =>
                    fetchCiphertextWithRetry(url, signal, logCtx, videoId, deps.fetchCiphertext),
                  refreshUpstreamUrl,
                });
              } catch (refreshErr) {
                // URL refresh failed — fall through to honest error below.
                // P1-C: a temp-budget refusal here is pressure, not deletion:
                // answer retryable 503 rather than letting the original
                // 404/403 below become a misleading 410.
                if (refreshErr instanceof MediaTempBudgetError) {
                  console.warn(`[media] video ${videoId} temp budget exhausted on retry -> 503 fast`);
                  return NextResponse.json(
                    { error: 'The video is still being prepared; please retry in a moment.' },
                    { status: 503, headers: { 'Retry-After': '5' } },
                  );
                }
              }
              continue;
            }
            break;
          }
        }
        if (preflightErr) {
          const err = preflightErr;
          const st = (err as { upstreamStatus?: unknown }).upstreamStatus;
          if (st === 509) {
            const retry = (err as { retryAfter?: string | null }).retryAfter;
            return NextResponse.json(
              { error: 'MEGA bandwidth limit reached; retry shortly.' },
              { status: 503, headers: retry ? { 'Retry-After': retry } : undefined },
            );
          }
          if (st === 404 || st === 403) {
            // Persistent across the retry: genuinely unavailable.
            return NextResponse.json(
              { error: 'This file is no longer available on MEGA.' },
              { status: 410 },
            );
          }
          if (err instanceof RemuxSlotUnavailableError) {
            return NextResponse.json(
              { error: 'The video is still being prepared; please retry in a moment.' },
              { status: 503, headers: { 'Retry-After': '5' } },
            );
          }
          // Timeout (or an unknown early failure): surface a real error
          // instead of letting the browser spin. The live job keeps running
          // server-side, so a refresh typically finds warm bytes.
          return NextResponse.json(
            { error: 'The video is still preparing for playback; please retry in a moment.' },
            { status: 503, headers: { 'Retry-After': '5' } },
          );
        }
        // The viewer may have gone away during the waits above; creating a
        // response now would register a subscriber that can never detach
        // (phantom viewer pinning the job). Bail as a quiet 499 instead.
        throwIfAborted(signal);
        // Live-space Range decomposition (P0-C): the browser addresses the
        // fMP4 representation it is consuming, so start/end are taken RAW from
        // the header — never validated or clamped against the SOURCE size.
        // Suffix ranges need a known total and skip to the finished cache.
        // A dying job (zero-subscriber shutdown decided while this request was
        // in preflight) serves nothing live: start-0 falls through to the
        // seek/cache handling below, which resolves to the finished cache or
        // an honest bounded 503 (the player retries onto a fresh job).
        const liveSeek = rangeHeader ? rangeHeader.match(/^bytes=(\d+)-(\d*)$/) : null;
        const liveSuffix = rangeHeader ? /^bytes=-\d+$/.test(rangeHeader) : false;
        const liveStart = liveSeek ? Number(liveSeek[1]) : 0;
        if ((!rangeHeader || (liveSeek && liveStart === 0)) && !job.dying) {
          // Never commit a 200 that may sit silent: wait (bounded) for actual
          // init bytes so the browser receives a stream that is immediately
          // playable. Cold first plays start in seconds; a job that cannot
          // publish init within the budget answers a retryable 503 instead of
          // an empty stream that Chrome aborts a few seconds later.
          const initReady = await Promise.race([
            waitForLiveInit(job)
              .then(() => true)
              .catch(() => false),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), MEDIA_PREFLIGHT_TIMEOUT_MS),
            ),
          ]);
          if (!initReady) {
            return NextResponse.json(
              { error: 'The video player could not start the stream; please retry.' },
              { status: 503, headers: { 'Retry-After': '5' } },
            );
          }
          // Open-ended (`bytes=0-` / no Range) -> pure live stream (200).
          // Bounded start-0 (e.g. Safari's `bytes=0-1` probe) -> collect the
          // first end+1 live bytes and answer 206 (`*` = total unknown yet).
          // The end is a 0-anchored probe length, not a source coordinate.
          const liveEndRaw = liveSeek && liveSeek[2] !== '' ? Number(liveSeek[2]) : null;
          const endByte = liveEndRaw !== null && liveEndRaw < size - 1 ? liveEndRaw : null;
          console.warn(`[route] video ${videoId} createLiveResponse endByte=${endByte ?? 'open'} at +${logCtx.elapsedMs()}ms`);
          return createLiveResponse(job, endByte, signal);
        }
        // Cold seek (start > 0), Bug 2: the OLD behavior waited up to 45 s for
        // the complete faststart cache and then answered JSON 503 - which the
        // media element cannot interpret, killing playback on the first seek.
        // The remuxed fMP4 byte coordinates ARE the spool, so serve the seek
        // from the live window instead:
        //   - position already spooled (or the live is still running and will
        //     reach it): answer 206 from the spool immediately/bounded;
        //   - only when the live has ALREADY ENDED short of the position (dead
        //     job, no future bytes) do we fall back to the completed cache or
        //     an honest bounded wait for it.
        //
        // P0-C: `start`/`end` below are fMP4 OUTPUT (spool) offsets — the byte
        // space of the representation the browser is consuming (it derived its
        // Range from the live stream itself, which starts with the init
        // segment it already holds, so no init is prepended and no
        // source-size clamp applies). Suffix ranges (bytes=-N) cannot map to
        // an unknown-length live total and skip straight to the finished
        // cache, which serves them with real coordinates.
        const liveRawEnd = liveSeek && liveSeek[2] !== '' ? Number(liveSeek[2]) : null;
        const liveRangeSane = liveRawEnd === null || liveRawEnd >= liveStart;
        if (!liveSuffix && liveRangeSane && liveStart > 0 && canServeSeekFromSpool(job, liveStart)) {
          const frontier = await waitForSpoolOffset(job, liveStart, signal);
          if (frontier > liveStart) {
            console.warn(
              `[route] video ${videoId} cold seek served from live spool start=${liveStart} frontier=${frontier} at +${logCtx.elapsedMs()}ms`,
            );
            return createLiveResponse(job, liveRawEnd, signal, liveStart);
          }
          // waitForSpoolOffset settled without reaching the position: the live
          // ended early. Fall through to the cache/failure handling below.
          console.warn(
            `[route] video ${videoId} cold seek outpaced (frontier=${frontier}, liveEnded=${job.liveEnded}) at +${logCtx.elapsedMs()}ms`,
          );
        }
        // Cold seek the live cannot serve (ended short / failed): wait a
        // BOUNDED time for the faststart cache, then answer honestly.
        let done: { path: string; size: number } | null = null;
        try {
          done = await Promise.race([
            job.cache,
            new Promise<{ path: string; size: number } | null>((resolve) =>
              setTimeout(() => resolve(null), MEDIA_CACHE_WAIT_TIMEOUT_MS),
            ),
          ]);
        } catch {
          done = null;
        }
        if (done) {
          const seekRange = parseRange(rangeHeader, done.size);
          if (seekRange === 'invalid') {
            return new NextResponse(null, {
              status: 416,
              headers: { 'Content-Range': `bytes */${done.size}` },
            });
          }
          const rs = seekRange ? seekRange.start : 0;
          const re = seekRange ? seekRange.end : done.size - 1;
          return createCachedFileResponse(done.path, rs, re, done.size, signal);
        }
        return NextResponse.json(
          { error: 'The video is still preparing for playback; please retry in a moment.' },
          { status: 503, headers: { 'Retry-After': '10' } },
        );
      } finally {
        // Interest released: if this request never attached a viewer
        // (preflight failure/timeout/abort, cache-path exit) and nobody
        // is attached, arm the zero-subscriber grace check so an
        // abandoned preflight cannot hold a remux slot forever. No-op
        // when a viewer is attached or the job already settled.
        noteSubscriberDetached(job);
      }
    }

    // Range request to MEGA storage. The g-url is short-lived; the range is
    // expressed in the storage URL itself, so a retry re-issues the IDENTICAL
    // request (Range semantics preserved). Transient connect failures are
    // retried up to 3 attempts with short backoff; nothing else is.
    //
    // P0-C: this path serves SOURCE bytes, so the source-space verdict IS
    // authoritative here: unsatisfiable Ranges 416 (the early check only
    // 416s malformed Ranges now, deferring the rest to each branch).
    if (resolvedRange === 'invalid') {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    //
    // A lone storage 404/403/5xx may be a stale g-URL or a passing storage
    // hiccup rather than a deleted node, so it is retried ONCE with a FRESH
    // download URL after a short backoff. Only a repeated failure is treated
    // as genuinely unavailable (410) or unreachable (502). 509 (bandwidth
    // quota) is answered immediately and never retried here. A client that
    // went away (aborted) is never retried.
    let currentUpstreamUrl = upstreamUrl;
    let upstream = await fetchCiphertextWithRetry(
      `${currentUpstreamUrl}/${apiStart}-${resolvedEnd}`,
      signal,
      logCtx,
      videoId,
      deps.fetchCiphertext,
    );
    if (
      !signal?.aborted &&
      (upstream.status === 404 || upstream.status === 403 ||
        (upstream.status >= 500 && upstream.status !== 509))
    ) {
      const firstStatus = upstream.status;
      try {
        evictCachedDownloadUrl(video.megaNodeId!);
        await new Promise((r) => setTimeout(r, UPSTREAM_STATUS_BACKOFF_MS));
        if (!signal?.aborted) {
          const fresh = await deps.withMegaSession(
            account.id,
            account.encryptedSession,
            async (storage) => getCachedDownloadUrl(video.megaNodeId!, storage, deps.getDownloadUrl),
          );
          currentUpstreamUrl = fresh.url;
          upstream = await fetchCiphertextWithRetry(
            `${currentUpstreamUrl}/${apiStart}-${resolvedEnd}`,
            signal,
            logCtx,
            videoId,
            deps.fetchCiphertext,
          );
        }
      } catch {
        // Refresh/retry failed — fall through to honest status below.
      }
      if (upstream.status !== firstStatus) {
        console.warn(
          `[media] video ${videoId} storage retry settled: first=${firstStatus} now=${upstream.status}`,
        );
      }
    }

    if (upstream.status === 509) {
      const retry = upstream.headers.get('x-mega-time-left');
      return NextResponse.json(
        { error: 'MEGA bandwidth limit reached; retry shortly.' },
        { status: 503, headers: retry ? { 'Retry-After': retry } : undefined },
      );
    }
    if (upstream.status === 404 || upstream.status === 403) {
      // Persistent across the fresh-URL retry: genuinely unavailable. It
      // will be removed from the library on the next sync.
      return NextResponse.json(
        { error: 'This file is no longer available on MEGA.' },
        { status: 410 },
      );
    }
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: 'MEGA storage servers are unreachable.' },
        { status: 502 },
      );
    }

    const fullRange = resolvedStart === 0 && resolvedEnd === size - 1;
    const decryptor = decrypt(fileKey, {
      start: apiStart,
      disableVerification: !fullRange,
    });

    const nodeUpstream = Readable.fromWeb(
      upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    
    // Handle abort signal cleanup
    let aborted = false;
    if (signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
        nodeUpstream.destroy();
        decryptor.destroy();
      });
    }

    nodeUpstream.on('error', (err: Error) => {
      // Surface as a stream error; the browser will show a playback error.
      if (!aborted) {
        decryptor.emit('error', err);
      }
    });

    // Order matters: the CTR keystream is positioned by `apiStart`, so the
    // DECRYPTOR must see the ciphertext exactly as MEGA stored it. Any
    // plaintext alignment/sizing happens AFTER decryption, never before.
    //
    // End propagation matters too: the pipes MUST forward `end` (the
    // default) so the decryptor flushes its final block (and verifies the
    // MAC on full-range requests) and the HTTP response actually
    // terminates. `{ end: false }` here deadlocked every stream: all bytes
    // arrived, but `end` never fired, leaving browsers stuck buffering.
    let chain: Readable = nodeUpstream.pipe(decryptor);
    if (skipBytes > 0) chain = chain.pipe(skipLeading(skipBytes));
    if (!fullRange) chain = chain.pipe(limitBytes(resolvedEnd - resolvedStart + 1));
    const outNode = chain;
    outNode.on('error', (err: Error) => {
      const code = (err as { code?: string }).code;
      // Only log if not aborted - aborts are expected during normal navigation
      if (!aborted && err.name !== 'AbortError') {
        console.warn(
          `[media] video ${videoId} stream error: ${JSON.stringify({ name: err.name, code: code ?? null, message: err.message.slice(0, 80) || null })}`,
        );
      }
    });

    // Ensure proper cleanup when stream ends
    outNode.on('end', () => {
      decryptor.end();
    });

    // Abort-safe adapter (Bug 4): guards every Web-Stream controller call so
    // a normal browser abort/reload can never surface as an uncaught
    // "Controller is already closed" while genuine errors still propagate.
    const webOut = nodeToWebSafe(outNode);

    const headers = new Headers({
      'Content-Type': effectiveMimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Media-Path': 'direct',
    });
    if (resolvedRange) {
      headers.set('Content-Range', `bytes ${resolvedStart}-${resolvedEnd}/${size}`);
      headers.set('Content-Length', String(resolvedEnd - resolvedStart + 1));
    } else {
      headers.set('Content-Length', String(size));
    }

    return new Response(webOut, {
      status: resolvedRange ? 206 : 200,
      headers,
    });
  } catch (err) {
    if (err instanceof MegaError) {
      if (err.kind === 'session-expired' || err.kind === 'auth' || err.kind === 'mfa') {
        evictMegaSession(account.id);
        await markAccountReauthRequired(account.id, 'MEGA session expired or was revoked. Reconnect required.');
        return NextResponse.json(
          { error: 'The MEGA session for this video expired. Reconnect the account to play.' },
          { status: 409 },
        );
      }
      if (err.apiCode === 9) {
        // P0 TRANSIENT-404 FIX: apiCode 9 (ENOENT) from the a=g URL fetch is
        // NOT proof the node is gone — a lone storage ENOENT self-resolved
        // live minutes later, so retry ONCE with a FRESH download URL
        // (bypassing the 5-minute URL cache: the cached g-URL itself may be
        // stale). Only a repeated failure answers 410. Auth/session errors
        // never reach here (handled above); genuine deletions fail twice and
        // still 410 correctly.
        try {
          evictCachedDownloadUrl(video.megaNodeId!);
          await new Promise((r) => setTimeout(r, UPSTREAM_STATUS_BACKOFF_MS));
          await deps.withMegaSession(
            account.id,
            account.encryptedSession,
            async (storage) => getCachedDownloadUrl(video.megaNodeId!, storage, deps.getDownloadUrl),
          );
          // Fresh URL resolved: the first ENOENT was transient. Answer a
          // retryable 503 (NOT 410) so the player retries — the next request
          // resolves the fresh URL from cache and streams normally.
          return NextResponse.json(
            { error: 'MEGA is temporarily unavailable. Try again shortly.' },
            { status: 503, headers: { 'Retry-After': '2' } },
          );
        } catch {
          return NextResponse.json(
            { error: 'This file is no longer available on MEGA.' },
            { status: 410 },
          );
        }
      }
      return NextResponse.json(
        { error: 'MEGA is temporarily unavailable. Try again shortly.' },
        { status: 503 },
      );
    }
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted')) {
      // P1 LOGGING FIX: a browser that closes/supersedes its Range request
      // (navigation, or replacing bytes=0- with a follow-up Range) surfaces
      // here as ResponseAborted/AbortError from the Next.js pipeline. That
      // is NORMAL client behavior — never a "playback setup failure", never
      // retried, never touching shared jobs, never marking the video broken.
      // Debug level only; genuine server-side failures keep the warn below.
      console.debug(`[media] video ${videoId} client ${err.name} (normal, ignored)`);
      // client went away - nothing to do
      return new NextResponse(null, { status: 499 });
    }
    // Safe failure diagnostics: error CLASS only (never messages that could
    // carry URLs/keys), plus video id, node handle, range, elapsed time.
    const errClass = isTransientNetworkError(err)
      ? 'transient-network'
      : err instanceof Error && err.name === 'TypeError'
        ? 'fetch-failed'
        : err instanceof Error
          ? 'error'
          : 'unknown';
    console.warn(
      `[media] playback setup failed: ${JSON.stringify({
        ...logCtx.safeFields(),
        elapsedMs: logCtx.elapsedMs(),
        errorClass: errClass,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message.slice(0, 200) : undefined,
        detail: err instanceof Error && errClass === 'transient-network' ? (err as { cause?: { code?: string } }).cause?.code ?? err.message.slice(0, 60) : undefined,
      })}`,
    );
    return NextResponse.json(
      { error: 'Could not start playback right now.' },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  return handleMediaRequest(
    user?.id ?? null,
    (await params).videoId,
    request.headers,
    request.signal,
    undefined,
    request.method,
  );
}
