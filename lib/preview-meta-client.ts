/**
 * Phase 5: client-side hover-preview meta cache.
 *
 * Rapid movement across cards must issue at most one meta request per video
 * per page (design §10), and a known-ready hover URL is reused instantly on
 * repeat hovers. Page-lifetime module cache — no persistence, no invalidation
 * beyond reload (a stale clip URL simply 404s and the card falls back).
 */

export interface CardPreviewMeta {
  /** Ready hover clip route URL, or null when not ready. */
  hoverUrl: string | null;
}

const cache = new Map<number, CardPreviewMeta>();

const META_TIMEOUT_MS = 5000;
const GENERATING_REPOLL_MS = 2500;

export function cachedCardPreviewMeta(videoId: number): CardPreviewMeta | null {
  return cache.get(videoId) ?? null;
}

async function fetchMetaOnce(videoId: number): Promise<CardPreviewMeta | null> {
  const timeout = AbortSignal.timeout(META_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/preview/${videoId}/meta?want=hover`, { signal: timeout });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      status?: string;
      hover?: { url?: string } | null;
    };
    const hoverUrl = data.hover?.url ?? null;
    const meta: CardPreviewMeta = { hoverUrl };
    if (hoverUrl) cache.set(videoId, meta);
    return meta;
  } catch {
    return null;
  }
}

/**
 * Resolve the hover preview for a card the moment hover fires:
 *  - known-ready from cache → immediate;
 *  - `ready` in meta → cached and returned;
 *  - `generating` → exactly one bounded re-poll (~2.5 s), then give up
 *    (the card keeps its thumbnail; a later hover tries again);
 *  - anything else → null (caller falls back to the iframe preview).
 */
export async function resolveCardHoverPreview(videoId: number): Promise<string | null> {
  const cached = cache.get(videoId);
  if (cached?.hoverUrl) return cached.hoverUrl;
  const meta = await fetchMetaOnce(videoId);
  if (meta?.hoverUrl) return meta.hoverUrl;
  return null;
}

/** One bounded re-poll for `generating` states (design §10). */
export async function repollCardHoverPreview(videoId: number): Promise<string | null> {
  try {
    await new Promise((r) => setTimeout(r, GENERATING_REPOLL_MS));
  } catch {
    return null;
  }
  return resolveCardHoverPreview(videoId);
}
