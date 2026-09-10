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
import { keepAliveFetch, withTransientRetry, isTransientNetworkError } from '@/lib/net-resilience';

// The media route uses node:stream, megajs CTR decryption and the Node-only
// network stack. Pin it to the Node.js runtime explicitly.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  signal: AbortSignal,
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
        if (signal.aborted) return false;
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

  try {
    const { upstreamUrl, size } = await deps.withMegaSession(
      account.id,
      account.encryptedSession,
      async (storage) => {
        const dl = await deps.getDownloadUrl(storage, video.megaNodeId!);
        const size =
          dl.size ?? (video.fileSize !== null ? Number(video.fileSize) : null);
        return { upstreamUrl: dl.url, size };
      },
    );

    if (size === null || !Number.isFinite(size) || size < 0) {
      return NextResponse.json(
        { error: 'File size unknown to MEGA right now.' },
        { status: 502 },
      );
    }

    const range = parseRange(requestHeaders.get('range'), size);
    if (range === 'invalid') {
      return new NextResponse(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}` },
      });
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;

    const apiStart = start - (start % 16);
    const skipBytes = start - apiStart;

    // Sniff the actual MIME type from the file content so browsers receive
    // the correct Content-Type even when the stored extension-based value
    // is wrong (e.g. a .mp4 file that is actually an MPEG-TS stream).
    // Only on range-start-0 requests (metadata fetch): Chrome always issues
    // one open-ended request from 0 first, so seeks skip this extra upstream
    // round-trip entirely.
    let effectiveMimeType = video.mimeType ?? 'video/mp4';
    if (start === 0) {
      try {
      const sniffRes = await deps.fetchCiphertext(`${upstreamUrl}/0-187`, signal);
      if (sniffRes.ok) {
        const sniffBuf = Buffer.from(await sniffRes.arrayBuffer());
        const { decrypt: megaDecrypt } = await import('megajs');
        const decryptor = megaDecrypt(fileKey, { start: 0, disableVerification: true });
        const decrypted = Buffer.concat([
          decryptor.update(sniffBuf),
          decryptor.final(),
        ]);
        const detected = sniffMimeType(decrypted);
        if (detected && detected !== effectiveMimeType) {
          effectiveMimeType = detected;
          await prisma.video.update({ where: { id: video.id }, data: { mimeType: detected } }).catch(() => {});
        }
      }
      } catch {
        // Sniff failure is non-fatal; fall back to stored MIME type.
      }
    }

    // Range request to MEGA storage. The g-url is short-lived; the range is
    // expressed in the storage URL itself, so a retry re-issues the IDENTICAL
    // request (Range semantics preserved). Transient connect failures are
    // retried up to 3 attempts with short backoff; nothing else is.
    const storageUrl = `${upstreamUrl}/${apiStart}-${end}`;
    const upstream = await fetchCiphertextWithRetry(storageUrl, signal, logCtx, videoId, deps.fetchCiphertext);

    if (upstream.status === 509) {
      const retry = upstream.headers.get('x-mega-time-left');
      return NextResponse.json(
        { error: 'MEGA bandwidth limit reached; retry shortly.' },
        { status: 503, headers: retry ? { 'Retry-After': retry } : undefined },
      );
    }
    if (upstream.status === 404 || upstream.status === 403) {
      // The node vanished (or the temporary URL was rejected) - it will be
      // removed from the library on the next sync.
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

    const fullRange = start === 0 && end === size - 1;
    const decryptor = decrypt(fileKey, {
      start: apiStart,
      disableVerification: !fullRange,
    });

    const nodeUpstream = Readable.fromWeb(
      upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0],
    );
    nodeUpstream.on('error', (err: Error) => {
      // Surface as a stream error; the browser will show a playback error.
      decryptor.emit('error', err);
    });

    // Order matters: the CTR keystream is positioned by `apiStart`, so the
    // DECRYPTOR must see the ciphertext exactly as MEGA stored it. Any
    // plaintext alignment/sizing happens AFTER decryption, never before.
    let chain: Readable = nodeUpstream.pipe(decryptor);
    if (skipBytes > 0) chain = chain.pipe(skipLeading(skipBytes));
    if (!fullRange) chain = chain.pipe(limitBytes(end - start + 1));
    const outNode = chain;
    outNode.on('error', (err: Error) => {
      const code = (err as { code?: string }).code;
      console.warn(
        `[media] video ${videoId} stream error: ${JSON.stringify({ name: err.name, code: code ?? null, message: err.message.slice(0, 80) || null })}`,
      );
    });

    const webOut = Readable.toWeb(outNode) as unknown as ReadableStream<Uint8Array>;

    const headers = new Headers({
      'Content-Type': effectiveMimeType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (range) {
      headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
      headers.set('Content-Length', String(end - start + 1));
    } else {
      headers.set('Content-Length', String(size));
    }

    return new Response(webOut, {
      status: range ? 206 : 200,
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
        return NextResponse.json(
          { error: 'This file is no longer available on MEGA.' },
          { status: 410 },
        );
      }
      return NextResponse.json(
        { error: 'MEGA is temporarily unavailable. Try again shortly.' },
        { status: 503 },
      );
    }
    if (err instanceof Error && err.name === 'AbortError') {
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
  );
}
