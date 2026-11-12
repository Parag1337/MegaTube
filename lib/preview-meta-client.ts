/**
 * Phase 5: client-side hover-preview meta cache + bounded readiness wait.
 *
 * Rapid movement across cards must issue at most one meta request per video
 * per page for a KNOWN-READY clip (design §10). Cold videos are different:
 * the first hover triggers background generation, so the card polls the
 * (cheap) meta endpoint until the clip is ready while the pointer stays on
 * the card. Polling is bounded — 30 s total — and stops immediately when the
 * pointer leaves, the card switches, or the server reports a terminal state.
 *
 * Phase 5.1: the wait result also reports the server status (`pending`,
 * `queued`, `generating`, `failed`, `unsupported`, …) so the loading
 * indicator can say what is actually happening instead of spinning blindly.
 *
 * Page-lifetime module cache — no persistence; a stale clip URL simply 404s
 * and the card falls back.
 */

export interface CardPreviewMeta {
  /** Ready hover clip route URL, or null when not ready. */
  hoverUrl: string | null;
}

const cache = new Map<number, CardPreviewMeta>();

const META_TIMEOUT_MS = 5000;

/** Defaults for waiting out a cold background generation. */
const GENERATING_POLL_INTERVAL_MS = 2000;
const GENERATING_WAIT_MS = 30_000;

/** Server states that can still become ready without user action. */
const WAITABLE_STATUSES = new Set(['pending', 'queued', 'generating']);

export function cachedCardPreviewMeta(videoId: number): CardPreviewMeta | null {
  return cache.get(videoId) ?? null;
}

interface MetaFetchResult {
  status: string;
  hoverUrl: string | null;
}

async function fetchMetaOnce(videoId: number): Promise<MetaFetchResult | null> {
  const timeout = AbortSignal.timeout(META_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/preview/${videoId}/meta?want=hover`, { signal: timeout });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      hover?: { url?: string } | null;
    };
    const hoverUrl = data.hover?.url ?? null;
    if (hoverUrl) cache.set(videoId, { hoverUrl });
    return { status: data.status ?? 'unavailable', hoverUrl };
  } catch {
    return null;
  }
}

/**
 * Resolve the hover preview the moment hover fires:
 *  - known-ready from cache → immediate;
 *  - `ready` in meta → cached and returned;
 *  - anything else → null (the caller decides whether to wait/fall back).
 */
export async function resolveCardHoverPreview(videoId: number): Promise<string | null> {
  return (await resolveCardHoverPreviewState(videoId)).url;
}

/** Same as `resolveCardHoverPreview` but keeps the server status. */
export async function resolveCardHoverPreviewState(
  videoId: number,
): Promise<{ url: string | null; status: string }> {
  const cached = cache.get(videoId);
  if (cached?.hoverUrl) return { url: cached.hoverUrl, status: 'ready' };
  const meta = await fetchMetaOnce(videoId);
  return { url: meta?.hoverUrl ?? null, status: meta?.status ?? 'unavailable' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HoverWaitResult {
  url: string | null;
  /** Last server status observed, or 'unavailable' when none was received. */
  status: string;
  timedOut: boolean;
}

/**
 * Wait (bounded) for a cold preview to finish generating. The meta endpoint
 * admits the job and answers `generating` immediately; this loop polls until
 * the clip is ready, the server reports a terminal state, the pointer leaves
 * (`isActive` false), or the timeout expires.
 *
 * `onStatus` fires for every observed state so the card can label its
 * loading indicator truthfully (preparing / waiting / loading).
 */
export async function waitForCardHoverPreviewDetailed(
  videoId: number,
  isActive: () => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number; onStatus?: (status: string) => void },
): Promise<HoverWaitResult> {
  const timeoutMs = opts?.timeoutMs ?? GENERATING_WAIT_MS;
  const intervalMs = opts?.intervalMs ?? GENERATING_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let status = 'unavailable';

  while (Date.now() < deadline) {
    if (!isActive()) return { url: null, status, timedOut: false };
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    if (!isActive()) return { url: null, status, timedOut: false };

    const cached = cache.get(videoId);
    if (cached?.hoverUrl) return { url: cached.hoverUrl, status: 'ready', timedOut: false };

    const meta = await fetchMetaOnce(videoId);
    if (!meta) return { url: null, status, timedOut: false }; // network/auth failure
    status = meta.status;
    opts?.onStatus?.(status);
    if (meta.hoverUrl) return { url: meta.hoverUrl, status: 'ready', timedOut: false };
    if (!WAITABLE_STATUSES.has(meta.status)) {
      // Terminal: failed / unsupported / unavailable / rejected.
      return { url: null, status: meta.status, timedOut: false };
    }
  }
  return { url: null, status, timedOut: true };
}

/**
 * Backwards-compatible wrapper: returns only the clip URL.
 */
export async function waitForCardHoverPreview(
  videoId: number,
  isActive: () => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string | null> {
  const result = await waitForCardHoverPreviewDetailed(videoId, isActive, opts);
  return result.url;
}
