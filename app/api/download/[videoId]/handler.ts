import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
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
import { keepAliveFetch, withTransientRetry, isTransientNetworkError } from '@/lib/net-resilience';
import { nodeToWebSafe } from '@/lib/media/remux';
import {
  buildContentDisposition,
  extensionForMimeType,
  mimeTypeForDownload,
  sanitizeDownloadFilename,
} from '@/lib/download';

// The download route uses node:stream, megajs CTR decryption and the
// Node-only network stack. Pin it to the Node.js runtime explicitly.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Single-file ORIGINAL download (never the playback remux).
 *
 * Pipeline (same foundations as /api/media/[videoId], playback untouched):
 *   session resume (withMegaSession) -> a=g temp URL -> MEGA ciphertext
 *   fetch -> megajs AES-128-CTR decrypt (MAC verified, full file) ->
 *   HTTP attachment stream with backpressure.
 *
 * Nothing is buffered: the decrypted stream is piped straight to the
 * response. No ffmpeg, no remux, no disk copies - the original MEGA bytes.
 */

// ---------------------------------------------------------------------------
// Short-lived MEGA temp-URL cache (same shape as the media route's; kept
// local so playback code is never touched). URLs live ~10 min; cached 5.
// ---------------------------------------------------------------------------

interface CachedDownloadUrl {
  url: string;
  size: number | null;
  expiresAt: number;
}

const downloadUrlCache = new Map<string, CachedDownloadUrl>();
const downloadUrlInflight = new Map<string, Promise<TemporaryDownloadUrl>>();

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
 * Injectable MEGA boundary (mirrors the media route's MediaDeps) so tests
 * can exercise the handler with fake URLs + genuinely megajs-encrypted
 * ciphertext without touching the real MEGA network.
 */
export interface DownloadDeps {
  /** Run fn with a live MEGA session (default: resume from stored material). */
  withMegaSession: typeof withMegaSession;
  /** Resolve a short-lived download URL (+ size) for a node. */
  getDownloadUrl: (storage: unknown, nodeId: string) => Promise<TemporaryDownloadUrl>;
  /** Fetch ciphertext bytes from MEGA storage (range embedded in the URL). */
  fetchCiphertext: (url: string, signal?: AbortSignal) => Promise<Response>;
}

const defaultDownloadDeps: DownloadDeps = {
  withMegaSession,
  getDownloadUrl: (storage, nodeId) =>
    getTemporaryDownloadUrl(storage as Parameters<typeof getTemporaryDownloadUrl>[0], nodeId),
  fetchCiphertext: (url, signal) => keepAliveFetch(url, { signal }),
};

const UPSTREAM_STATUS_BACKOFF_MS = 800;

/**
 * Core handler. `rawUserId` is the authenticated website user id (null when
 * unauthenticated). Split out of the route wrapper so tests can drive it
 * without next/headers request scope; behavior is identical.
 */
export async function handleDownloadRequest(
  rawUserId: string | null,
  videoIdParam: string,
  signal: AbortSignal | undefined,
  deps: DownloadDeps = defaultDownloadDeps,
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
    include: {
      megaAccount: {
        select: { id: true, userId: true, status: true, encryptedSession: true },
      },
    },
  });

  // Ownership is enforced here, server-side, from the session user only.
  // A missing row or a row belonging to someone else answers identically,
  // and nothing from the client (node id, account id, filename) is trusted.
  if (!video || !video.megaAccount || video.megaAccount.userId !== rawUserId) {
    return NextResponse.json({ error: 'Video not found.' }, { status: 404 });
  }

  if (!video.megaNodeId || !video.fileKeyEncrypted) {
    return NextResponse.json({ error: 'This video is not downloadable yet.' }, { status: 409 });
  }

  const account = video.megaAccount;
  if (account.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
    return NextResponse.json(
      { error: 'The MEGA account for this video is disconnected.' },
      { status: 410 },
    );
  }
  if (account.status === MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED) {
    return NextResponse.json(
      { error: 'This video needs its MEGA account reconnected before it can download.' },
      { status: 409 },
    );
  }

  const filename = sanitizeDownloadFilename(
    video.megaFilename,
    video.title,
    extensionForMimeType(video.mimeType),
  );
  const contentType = mimeTypeForDownload(video.mimeType, filename);
  const disposition = buildContentDisposition(filename);

  // HEAD probes must never touch MEGA: answer availability + download
  // metadata from stored rows only (used by the Download All queue to
  // classify failures before spending a multi-download permission).
  if (method === 'HEAD') {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Disposition': disposition,
      'Cache-Control': 'no-store',
    };
    if (video.fileSize !== null) headers['Content-Length'] = String(Number(video.fileSize));
    return new Response(null, { status: 200, headers });
  }

  let fileKey: Buffer;
  try {
    fileKey = decryptSecret(video.fileKeyEncrypted);
  } catch {
    return NextResponse.json({ error: 'Stored download key is unreadable.' }, { status: 500 });
  }

  try {
    const { upstreamUrl, size } = await withTransientRetry(
      () =>
        deps.withMegaSession(account.id, account.encryptedSession, async (storage) => {
          const resolved = await getCachedDownloadUrl(video.megaNodeId!, storage, deps.getDownloadUrl);
          const resolvedSize =
            resolved.size ?? (video.fileSize !== null ? Number(video.fileSize) : null);
          return { upstreamUrl: resolved.url, size: resolvedSize };
        }),
      {
        attempts: 2,
        isTransient: (err) =>
          (err instanceof MegaError && err.kind === 'transient') || isTransientNetworkError(err),
      },
    );

    if (size === null || !Number.isFinite(size) || size < 0) {
      return NextResponse.json(
        { error: 'File size unknown to MEGA right now.' },
        { status: 502 },
      );
    }

    // Full original file, byte 0..size-1. The g-url range is 16-aligned by
    // construction (start 0), so no keystream-shift handling is needed.
    let currentUpstreamUrl = upstreamUrl;
    let upstream = await deps.fetchCiphertext(`${currentUpstreamUrl}/0-${size - 1}`, signal);
    if (
      !signal?.aborted &&
      (upstream.status === 404 || upstream.status === 403 ||
        (upstream.status >= 500 && upstream.status !== 509))
    ) {
      // One fresh-URL retry for stale g-URLs / passing storage hiccups.
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
          upstream = await deps.fetchCiphertext(`${currentUpstreamUrl}/0-${size - 1}`, signal);
        }
      } catch {
        // fall through to honest status below
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

    // Full-file decrypt with MAC verification (disableVerification: false):
    // a corrupt upstream fails the stream instead of writing a bad file.
    const decryptor = decrypt(fileKey, { start: 0, disableVerification: false });
    const nodeUpstream = Readable.fromWeb(
      upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );

    // Client disconnect: abort upstream + destroy the decryptor so no
    // orphaned MEGA download keeps running for a gone browser.
    let aborted = false;
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          try {
            nodeUpstream.destroy();
          } catch {
            // ignore
          }
          try {
            decryptor.destroy();
          } catch {
            // ignore
          }
        },
        { once: true },
      );
    }
    nodeUpstream.on('error', (err: Error) => {
      if (!aborted) decryptor.emit('error', err);
    });
    const outNode: Readable = nodeUpstream.pipe(decryptor);
    outNode.on('error', (err: Error) => {
      if (!aborted && err.name !== 'AbortError') {
        console.warn(
          `[download] video ${videoId} stream error: ${err.name} ${(err.message ?? '').slice(0, 80)}`,
        );
      }
    });

    // Abort-safe adapter (same as playback): a cancelled download can never
    // surface as an uncaught "Controller is already closed".
    const webOut = nodeToWebSafe(outNode);

    return new Response(webOut, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Content-Length': String(size),
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof MegaError) {
      if (err.kind === 'session-expired' || err.kind === 'auth' || err.kind === 'mfa') {
        evictMegaSession(account.id);
        await markAccountReauthRequired(account.id, 'MEGA session expired or was revoked. Reconnect required.');
        return NextResponse.json(
          { error: 'The MEGA session for this video expired. Reconnect the account to download.' },
          { status: 409 },
        );
      }
      return NextResponse.json(
        { error: 'MEGA is temporarily unavailable. Try again shortly.' },
        { status: 503 },
      );
    }
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'ResponseAborted')) {
      return new NextResponse(null, { status: 499 });
    }
    console.warn(`[download] setup failed video ${videoId}: ${err instanceof Error ? `${err.name} ${(err.message ?? '').slice(0, 120)}` : typeof err}`);
    return NextResponse.json(
      { error: 'Could not start the download right now.' },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  return handleDownloadRequest(user?.id ?? null, (await params).videoId, request.signal);
}

export async function HEAD(request: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  const user = await getCurrentUser();
  return handleDownloadRequest(user?.id ?? null, (await params).videoId, request.signal, undefined, 'HEAD');
}
