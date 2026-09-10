/**
 * Node-only network resilience for the MEGA integration.
 *
 * (Node-only: imports node:dns and node:net. Callers must only load this
 * module from Node.js runtime contexts — the instrumentation hook gates on
 * process.env.NEXT_RUNTIME, and the media route is declared
 * `export const runtime = 'nodejs'`.)
 *
 * Problems observed in the wild (dev box + LAN/Tailscale setups):
 *   1. MEGA publishes A + AAAA records; IPv6 is often unreachable
 *      (ENETUNREACH). undici's per-address connect timeout (250 ms) is
 *      shorter than the real TCP handshake to MEGA (~350-700 ms on such
 *      hosts), so every address attempt "times out" -> fetch fails with
 *      ETIMEDOUT / "fetch failed" even though the network is fine.
 *   2. Every browser range request opened a FRESH upstream connection
 *      (global fetch without keep-alive hints), adding a full TCP+TLS
 *      handshake to the latency of every seek and increasing exposure to
 *      transient connect failures.
 *
 * Fixes (process-wide defaults + a dedicated keep-alive fetcher):
 *   - ipv4first DNS ordering so dead IPv6 paths are not tried first
 *   - a more forgiving per-address auto-select attempt timeout
 *   - keepAliveFetch(): a fetch bound to an undici Agent with keep-alive so
 *     repeated range requests reuse TLS connections to MEGA storage.
 */
import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

let applied = false;

export function applyNetworkResilience(): void {
  if (applied) return;
  applied = true;
  try {
    dns.setDefaultResultOrder('ipv4first');
  } catch {
    // older runtimes; ignore
  }
  try {
    const setter = (
      net as typeof net & { setDefaultAutoSelectFamilyAttemptTimeout?: (ms: number) => void }
    ).setDefaultAutoSelectFamilyAttemptTimeout;
    if (typeof setter === 'function') setter.call(net, 1000);
  } catch {
    // older runtimes; ignore
  }
}

// ---------------------------------------------------------------------------
// Keep-alive fetcher for upstream MEGA storage requests
// ---------------------------------------------------------------------------

/** One shared keep-alive agent for MEGA storage traffic. */
const megaAgent = new Agent({
  // undici 8: connections are kept alive by default; keepAliveTimeout*
  // control idle socket reuse.
  keepAliveMaxTimeout: 30_000,
  // A few connections are enough for a single-user video session; a small
  // pool avoids connection churn without pinning resources.
  connections: 16,
  // Bound stalls: without these, a MEGA socket that accepts a request but
  // never answers pends up to undici's 300 s defaults, leaving the browser
  // at 0:00 with "Waiting for localhost". 30 s for headers / 60 s of body
  // silence fails fast into retry/fallback instead. Healthy (even slow,
  // ~2 MB/s) streams deliver constantly and are unaffected - only true
  // silence trips these.
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
});

export interface KeepAliveFetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * fetch() bound to the shared keep-alive Agent. Same signature subset as
 * global fetch used by the media route; response is the standard Response.
 */
export function keepAliveFetch(
  url: string,
  init: KeepAliveFetchInit = {},
): Promise<Response> {
  return undiciFetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    signal: init.signal,
    dispatcher: megaAgent,
  }) as unknown as Promise<Response>;
}

/** Test hook: replace the dispatcher (used by unit tests only). */
export function __setMegaDispatcherForTests(dispatcher: unknown): void {
  (megaAgent as unknown as { dispatcher: unknown }).dispatcher = dispatcher;
}

// ---------------------------------------------------------------------------
// Bounded retry for transient upstream failures
// ---------------------------------------------------------------------------

/**
 * Run `op` with a small bounded retry for TRANSIENT network failures only.
 *
 * - max 3 attempts total (initial + 2 retries)
 * - short exponential backoff: ~150 ms, ~300 ms (jittered)
 * - never retries auth/validation/application errors (isTransient decides)
 * - injectable sleep + classifier keep this unit-testable without real
 *   network calls
 */
export async function withTransientRetry<T>(
  op: () => Promise<T>,
  options: {
    attempts?: number;
    isTransient?: (err: unknown) => boolean;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const isTransient = options.isTransient ?? isTransientNetworkError;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransient(err)) throw err;
      // 150ms, 300ms, ... with slight jitter to avoid thundering retries.
      const base = 150 * 2 ** (attempt - 1);
      await sleep(base + Math.floor(Math.random() * 50));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Safe error classification for bounded retries
// ---------------------------------------------------------------------------

/**
 * Error classes worth retrying: transient connection-establishment and
 * reset problems. Never retried: auth, malformed input, application errors.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const code = e.cause?.code ?? '';
  
  // AbortError is not transient - it's a client cancellation
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return false;
  
  // ResponseAborted is also a client cancellation
  if (e.name === 'ResponseAborted') return false;
  
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  // undici/Node wraps connect failures as TypeError("fetch failed").
  if (e.name === 'TypeError' && typeof e.message === 'string' && e.message.toLowerCase().includes('fetch failed')) {
    return true;
  }
  return false;
}
