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
  const cached = cache.get(videoId);
  if (cached?.hoverUrl) return cached.hoverUrl;
  const meta = await fetchMetaOnce(videoId);
  return meta?.hoverUrl ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait (bounded) for a cold preview to finish generating. The meta endpoint
 * admits the job and answers `generating` immediately; this loop polls until
 * the clip is ready, the server reports a terminal state, the pointer leaves
 * (`isActive` false), or the timeout expires. Returns the clip URL or null.
 */
export async function waitForCardHoverPreview(
  videoId: number,
  isActive: () => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? GENERATING_WAIT_MS;
  const intervalMs = opts?.intervalMs ?? GENERATING_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isActive()) return null;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    if (!isActive()) return null;

    const cached = cache.get(videoId);
    if (cached?.hoverUrl) return cached.hoverUrl;

    const meta = await fetchMetaOnce(videoId);
    if (!meta) return null; // network/auth failure → caller falls back
    if (meta.hoverUrl) return meta.hoverUrl;
    if (meta.status !== 'generating') return null; // terminal: unavailable/rejected
  }
  return null;
}
