'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Gesture, MediaPlayer, MediaProvider, type MediaPlayerInstance } from '@vidstack/react';
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';
import {
  WarmingRetryController,
  type EndpointProbeResult,
} from '@/lib/player/retry';

interface PrivatePlayerProps {
  videoId: number;
  title: string;
}

type PlayerStatus =
  | { kind: 'ready' }
  | { kind: 'preparing'; attempt: number; retryInSec: number }
  | { kind: 'error'; message: string; unavailable: boolean };

export function PrivatePlayer({ videoId, title }: PrivatePlayerProps) {
  // Fresh player state per video (status, nonce, controller, refs) without
  // any reset effects: remounting on video change discards everything.
  return <PlayerBody key={videoId} videoId={videoId} title={title} />;
}

/**
 * Private MEGA video player (owner only).
 *
 * Media comes exclusively from our authenticated endpoint - the browser
 * never sees MEGA download URLs, session ids, or keys. The endpoint serves
 * direct MP4 or remuxed fMP4/MP4 with Range support; Vidstack is only the
 * UI/interaction layer on top of the same <video> behavior.
 *
 * P1 AUTOPLAY (intentional video-page open): muted + playsInline + a single
 * can-play play() attempt — the only policy-compatible path. No loop, no
 * per-render calls, manual pause never overridden.
 *
 * P1.3 WARMING RECOVERY: a bare media element reports a 503-while-warming
 * only as a generic network error, so on error the player probes the
 * endpoint itself (one tiny `bytes=0-0` fetch per error episode) and lets
 * WarmingRetryController decide: bounded auto-retry honoring Retry-After
 * (max 3, preparing UI, seek target preserved) vs manual panel (410,
 * permanent 4xx, exhausted budget). Remounts happen ONLY from the retry
 * timer, manual Retry, or video change — never per render/event — so no
 * error -> src -> error loop can form.
 */
function PlayerBody({ videoId, title }: PrivatePlayerProps) {
  const [status, setStatus] = useState<PlayerStatus>({ kind: 'ready' });
  const [retryNonce, setRetryNonce] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const attemptedAutoplay = useRef(false);
  const playedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<MediaPlayerInstance | null>(null);

  // One tiny ranged probe per error episode: the media element hides HTTP
  // status, so ask the endpoint directly (same URL, 1 byte). Bounded by a
  // 30 s timeout mapped to fetchFailed (bounded backoff); only a genuine
  // cancel (unmount/video change) rethrows to drop the episode.
  const ctrlRef = useRef<WarmingRetryController | null>(null);
  if (ctrlRef.current == null) {
    ctrlRef.current = new WarmingRetryController(
      async (signal: AbortSignal): Promise<EndpointProbeResult> => {
        const timeout = AbortSignal.timeout(30_000);
        const combined = AbortSignal.any([timeout, signal]);
        try {
          const res = await fetch(`/api/media/${videoId}`, {
            headers: { Range: 'bytes=0-0' },
            signal: combined,
          });
          // Body is at most a byte or a small JSON error; drain it so the
          // connection can be reused, then decide purely on status + headers.
          await res.arrayBuffer().catch(() => {});
          return { status: res.status, retryAfter: res.headers.get('retry-after') };
        } catch (err) {
          if (signal.aborted) throw err;
          return { fetchFailed: true };
        }
      },
      {
        onPreparing: (attempt, delayMs) => {
          console.debug(`[player] video ${videoId} warming: auto-retry ${attempt}/3 in ${Math.ceil(delayMs / 1000)}s`);
          setStatus({ kind: 'preparing', attempt, retryInSec: Math.max(1, Math.ceil(delayMs / 1000)) });
        },
        onRetry: (attempt, resumeTime) => {
          console.debug(
            `[player] video ${videoId} auto-retry ${attempt}/3${resumeTime !== null ? ` resume@${resumeTime.toFixed(0)}s` : ''}`,
          );
          setStatus({ kind: 'ready' });
          // Remount only: the key change reloads the element (which also
          // re-arms the silent-dead-load detector below via retryNonce).
          // The saved seek target (if any) is applied on loadedmetadata.
          setRetryNonce((n) => n + 1);
        },
        onExhausted: (kind, message) => {
          console.debug(`[player] video ${videoId} retry budget exhausted (${kind})`);
          // The controller already selected the message: precise legacy
          // text for instantly-fatal decode errors, warming-flavored text
          // after retryable probes, unavailable for 410.
          setStatus({ kind: 'error', message, unavailable: kind === 'unavailable' });
        },
      },
    );
  }

  // Preparing countdown display, driven off status (not the retry timer
  // itself, which belongs to the controller).
  const isPreparing = status.kind === 'preparing';
  useEffect(() => {
    if (!isPreparing) return;
    const id = setInterval(() => {
      setStatus((s) => (s.kind === 'preparing' && s.retryInSec > 1 ? { ...s, retryInSec: s.retryInSec - 1 } : s));
    }, 1000);
    return () => clearInterval(id);
  }, [isPreparing]);

  // Unmount cleanup: in-flight probe, pending retry, nothing fires after.
  useEffect(() => {
    const instance = ctrlRef.current;
    return () => {
      instance?.cancel();
    };
  }, []);

  // Missed-event backstop (P1.3): the error event is the fast path, but a
  // load can also die without any element event reaching us (provider setup
  // quirks, swallowed setup-phase failures). Poll cheap element state:
  //  - el.error set          -> feed its code into the controller episode;
  //  - pre-playback, rs=0, networkState=NO_SOURCE(3), source assigned, for
  //    ~6 consecutive polls (12 s) -> one synthetic episode (code 2). A
  //    healthy warming load sits in LOADING(2), never NO_SOURCE, so this
  //    cannot mistake slow MEGA for a dead load.
  // Detection state is effect-local: every remount (retryNonce) re-arms it
  // for the brand-new element load.
  useEffect(() => {
    let ticks = 0;
    let fired = false;
    const id = setInterval(() => {
      const ctrl = ctrlRef.current;
      if (!ctrl) return;
      const el = containerRef.current?.querySelector('video');
      if (!el) return;
      if (el.error) {
        ctrl.handleError(el.error.code, Number.isFinite(el.currentTime) ? el.currentTime : null);
        return;
      }
      if (!playedRef.current && !fired && el.readyState === 0 && el.networkState === 3 && el.currentSrc !== '') {
        ticks += 1;
        if (ticks >= 6) {
          fired = true;
          console.debug(`[player] video ${videoId} silent dead load detected, probing endpoint`);
          ctrl.handleError(2, null);
        }
      } else {
        ticks = 0;
      }
    }, 2000);
    return () => clearInterval(id);
  }, [videoId, retryNonce]);

  // Stable object identity: a fresh { src, type } literal every render
  // makes Vidstack abort the in-flight load and restart it (double full
  // download per view, and a stuck spinner when the surviving element ends
  // up attached to the aborted request).
  //
  // retryNonce changes ONLY on actual (re)try: automatic timer fire or
  // manual Retry — never per render, never per event.
  const src = useMemo(
    () => ({
      src: retryNonce > 0 ? `/api/media/${videoId}?retry=${retryNonce}` : `/api/media/${videoId}`,
      type: 'video/mp4' as const,
    }),
    [videoId, retryNonce],
  );

  function applyPendingSeek(): void {
    const ctrl = ctrlRef.current;
    const target = ctrl?.pendingSeek;
    if (ctrl === null || ctrl === undefined || target === null || target === undefined) return;
    const player = playerRef.current as unknown as { currentTime?: unknown; duration?: unknown } | null;
    try {
      const duration = player?.duration;
      let t = target;
      if (typeof duration === 'number' && Number.isFinite(duration) && t >= duration) {
        t = Math.max(0, duration - 1);
      }
      if (player && typeof player.currentTime !== 'undefined') {
        (player as { currentTime: number }).currentTime = t;
        console.debug(`[player] video ${videoId} resumed near ${t.toFixed(0)}s after recovery`);
      }
    } catch {
      // Element not seekable yet — the browser keeps its own position.
    }
    ctrl.clearPendingSeek();
  }

  function manualRetry(): void {
    // Fresh budget, but the saved seek target survives inside the
    // controller so manual recovery lands near it too.
    ctrlRef.current?.manualRetry();
    attemptedAutoplay.current = false;
    setUserPaused(false);
    setStatus({ kind: 'ready' });
    setRetryNonce((n) => n + 1);
  }

  function handleMediaError(code: number | undefined): void {
    // Abort (code 1: navigation, remount, superseded Range) is normal
    // client behavior — never probe, never retry, never surface.
    // Everything else goes through the retry controller, which probes the
    // endpoint for the honest status first.
    if (code === 1) return;
    const t = (playerRef.current as unknown as { currentTime?: unknown } | null)?.currentTime;
    ctrlRef.current?.handleError(code, typeof t === 'number' ? t : null);
  }

  return (
    <div ref={containerRef} className="mt-player relative aspect-video w-full overflow-hidden rounded-2xl bg-black">
      {status.kind === 'error' ? (
        <div className="flex h-full w-full flex-col items-center justify-center bg-surface px-6 text-center">
          <div className="text-destructive mb-3">
            <svg className="h-10 w-10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <p className="text-base font-medium">{status.unavailable ? 'Video unavailable' : 'Video cannot be played'}</p>
          <p className="mt-2 text-sm text-muted">{status.message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            onClick={manualRetry}
          >
            Retry
          </button>
        </div>
      ) : status.kind === 'preparing' ? (
        <div className="flex h-full w-full flex-col items-center justify-center bg-surface px-6 text-center">
          <div className="text-white">
            <svg className="animate-spin h-8 w-8" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>
          <p className="mt-3 text-base font-medium">Preparing video…</p>
          <p className="mt-2 text-sm text-muted">
            Retrying in {status.retryInSec}s (attempt {status.attempt} of 3)
          </p>
          <button
            type="button"
            className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            onClick={() => ctrlRef.current?.retryNow()}
          >
            Retry now
          </button>
        </div>
      ) : (
        <MediaPlayer
          key={`${videoId}-${retryNonce}`}
          ref={playerRef}
          title={title}
          // The endpoint always serves MP4 bytes (direct MP4, or MPEG-TS
          // remuxed server-side). The URL carries no extension, so declare
          // the type explicitly - otherwise Vidstack falls back to header
          // sniffing an extra round-trip per load.
          src={src}
          poster={`/api/media/thumbs/${videoId}`}
          playsInline
          autoPlay={!userPaused}
          muted
          onLoadedMetadata={applyPendingSeek}
          onPlay={() => {
            setUserPaused(false);
          }}
          onPause={() => {
            setUserPaused(true);
          }}
          onPlaying={() => {
            playedRef.current = true;
            ctrlRef.current?.notifyPlaying();
          }}
          onCanPlay={(_detail, nativeEvent) => {
            // AUTOPLAY: exactly one attempt per mount, fired on can-play
            // (never on render/timer; never after manual pause). Muted +
            // playsInline is the only browser-policy-compatible path to
            // start without a gesture. Resolve → stays muted+playing;
            // reject → the video simply stays paused/muted with its normal
            // controls (no custom instructional overlay), no retry loop.
            // play() call/resolve/reject + readyState are instrumented.
            if (attemptedAutoplay.current) return;
            attemptedAutoplay.current = true;
            const el = (nativeEvent?.target as unknown as HTMLVideoElement | null) ?? null;
            const readyState = el?.readyState ?? -1;
            const isMuted = el?.muted ?? true;
            const autoplay = el?.autoplay ?? true;
            console.debug(
              `[player] video ${videoId} autoplay attempt (readyState=${readyState} muted=${isMuted} autoplay=${autoplay})`,
            );
            try {
              const p = el?.play?.();
              if (p && typeof (p as Promise<void>).then === 'function') {
                (p as Promise<void>).then(
                  () => {
                    console.debug(`[player] video ${videoId} play() resolved (autoplay)`);
                  },
                  (reason: unknown) => {
                    const msg =
                      reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
                    console.debug(`[player] video ${videoId} play() rejected: ${msg.slice(0, 160)}`);
                  },
                );
              }
            } catch (err) {
              const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
              console.debug(`[player] video ${videoId} play() threw: ${msg.slice(0, 160)}`);
            }
          }}
          onPlayFail={(detail) => {
            const reason = (detail as { reason?: unknown })?.reason;
            const msg =
              reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? 'autoplay blocked');
            console.debug(`[player] video ${videoId} auto-play-fail: ${msg.slice(0, 160)}`);
          }}
          onError={(e) => handleMediaError(e.code)}
        >
          <MediaProvider />
          {/* Tap zones (layout CSS positions/manages .vds-gesture by action:
              center toggles play, double-tap sides seek ∓10 s). */}
          <div className="vds-gestures">
            <Gesture className="vds-gesture" event="pointerup" action="toggle:paused" />
            <Gesture className="vds-gesture" event="dblpointerup" action="seek:-10" />
            <Gesture className="vds-gesture" event="dblpointerup" action="seek:10" />
          </div>
          <DefaultVideoLayout icons={defaultLayoutIcons} />
        </MediaPlayer>
      )}
      <span className="sr-only">{title}</span>
    </div>
  );
}
