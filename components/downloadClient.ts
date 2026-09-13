/**
 * Single shared client entry point for starting an original-file download.
 *
 * Both the card ⋮ menu and the video-page Download button call this — one
 * implementation, one endpoint (GET /api/download/[videoId]).
 *
 * Flow:
 *   1. per-video in-flight guard: a double-click never fires two downloads;
 *   2. HEAD preflight: cheap (no MEGA traffic) availability + ownership
 *      check. Failures surface as a readable error for the caller to display
 *      instead of navigating the user away to a JSON error page;
 *   3. on success, the download is dispatched into a hidden iframe. The
 *      browser handles the attachment normally, while a server-side error
 *      (e.g. the account flipped to reauth between preflight and dispatch)
 *      lands invisibly in the iframe instead of navigating the app away.
 *      No blob, no client-side memory.
 */

const inflight = new Set<number>();

export interface StartDownloadResult {
  started: boolean;
  /** Machine-readable reason when not started: 'busy' | 'error'. */
  reason?: 'busy' | 'error';
  /** Human-readable message for the caller to display on error. */
  message?: string;
}

/**
 * Dispatch a same-origin attachment download so the app page can never be
 * navigated away by a server-side error response. A hidden iframe receives
 * the response: an attachment triggers the normal browser download, while
 * a JSON error renders invisibly inside the frame. The frame is removed
 * after a generous window (the download handshake only needs headers).
 */
export function dispatchDownload(videoId: number): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.display = 'none';
  frame.src = `/api/download/${videoId}`;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 5 * 60_000);
}

function errorMessage(status: number, body: unknown): string {
  const server = (body as { error?: unknown } | null)?.error;
  if (typeof server === 'string' && server.length > 0) return server;
  if (status === 401) return 'Sign in to download this video.';
  if (status === 404) return 'This video is not available for download.';
  if (status === 409) return 'This video cannot be downloaded right now.';
  if (status === 410) return 'This file is no longer available on MEGA.';
  if (status === 503) return 'The download service is busy; try again shortly.';
  return 'Could not start the download.';
}

export async function startDownload(videoId: number): Promise<StartDownloadResult> {
  if (inflight.has(videoId)) return { started: false, reason: 'busy' };
  inflight.add(videoId);
  // Cooldown (not a lock): a second later the same video may legitimately
  // be downloaded again, but a double-click collapses into one request.
  window.setTimeout(() => inflight.delete(videoId), 3000);
  try {
    const url = `/api/download/${videoId}`;
    let head: Response;
    try {
      head = await fetch(url, { method: 'HEAD' });
    } catch {
      return { started: false, reason: 'error', message: 'Could not reach the download service.' };
    }
    if (!head.ok) {
      // HEAD has no body by definition; re-ask as GET only for the JSON
      // error payload is wasteful — classify from the status instead, but
      // prefer the server message when cheaply available.
      let message: string | undefined;
      try {
        const probe = await fetch(url, {
          method: 'GET',
          headers: { Range: 'bytes=0-0', Accept: 'application/json' },
        });
        // A 200 here means the file IS downloadable (range ignored, full
        // stream started server-side but we only read headers): cancel it
        // immediately and proceed to the anchor download.
        if (probe.ok || probe.status === 206) {
          await probe.body?.cancel().catch(() => {});
        } else {
          const data = await probe.json().catch(() => null);
          message = errorMessage(probe.status, data);
        }
      } catch {
        message = errorMessage(head.status, null);
      }
      if (message !== undefined) {
        return { started: false, reason: 'error', message };
      }
      // otherwise fall through to the iframe dispatch
    }
    dispatchDownload(videoId);
    return { started: true };
  } finally {
    // kept in the set until the cooldown timer fires (see above)
  }
}
