'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { tryMegaFileUrlToPreviewUrl } from '@/lib/mega/embed';
import {
  acquirePreview,
  releasePreview,
  removeMobileCandidate,
  reportMobileVisibility,
  MOBILE_VISIBILITY_THRESHOLD,
} from '@/lib/preview-manager';
import { previewDelayMs } from '@/lib/config';
import {
  cachedCardPreviewMeta,
  resolveCardHoverPreviewState,
  waitForCardHoverPreviewDetailed,
} from '@/lib/preview-meta-client';
import { formatDuration } from '@/components/format';
import { FilmIcon } from '@/components/icons';
import { PreviewVideo } from '@/components/PreviewVideo';
import { ThumbImage } from '@/components/ThumbImage';
import { VideoCardMenu } from '@/components/VideoCardMenu';

interface VideoCardProps {
  id: number;
  slug: string;
  title: string;
  megaUrl: string | null;
  megaFilename: string;
  thumbnail: string | null;
  duration?: number | null;
  creator: { slug: string; name: string } | null;
  /** Owned private video - enables the Change Creator menu option. */
  isPrivate?: boolean;
  /**
   * Home-feed source tag (recent/history/related/random/variety). Rendered
   * as a data attribute for tests/diagnostics only - never displayed.
   */
  feedSource?: string;
  priority?: boolean;
}

type PreviewState = 'idle' | 'pending' | 'active';

/** What the active preview renders: the local clip, or the iframe fallback. */
type PreviewView = { kind: 'local'; url: string } | { kind: 'iframe' } | null;

/**
 * Safety bound for local clip startup. The clip is tiny and served locally,
 * so a much longer wait means the media element is stuck; stop the loader and
 * use the existing fallback instead of leaving a spinner on the card forever.
 */
const LOCAL_PREVIEW_START_TIMEOUT_MS = 10_000;

/** Mobile autoplay: card must stay this visible for this long before playing. */
const MOBILE_DWELL_MS = 500;

/** Map a real server job state to the small corner indicator label. */
function previewStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Preparing preview';
    case 'queued':
      return 'Waiting for preview';
    case 'generating':
      return 'Loading preview';
    default:
      return 'Loading preview';
  }
}

export function VideoCard({
  id,
  slug,
  title,
  megaUrl,
  megaFilename,
  thumbnail,
  duration,
  creator,
  isPrivate = false,
  feedSource,
  priority = false,
}: VideoCardProps) {
  const [preview, setPreview] = useState<PreviewState>('idle');
  const [previewView, setPreviewView] = useState<PreviewView>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewLabel, setPreviewLabel] = useState('Loading preview');
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const mobileId = useId();
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const touchGuardUntilRef = useRef(0);
  const metaInFlightRef = useRef(false);
  /** Short grace timer: show the legacy iframe while local generation runs. */
  const iframeFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Stops the loading indicator if a local clip never starts playing. */
  const localStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Invalidates async meta chains when the preview stops (leave/switch). */
  const runIdRef = useRef(0);

  const previewSrc = megaUrl ? tryMegaFileUrlToPreviewUrl(megaUrl) : null;

  const stopSelf = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    activeRef.current = false;
    metaInFlightRef.current = false;
    runIdRef.current++;
    if (iframeFallbackRef.current) {
      clearTimeout(iframeFallbackRef.current);
      iframeFallbackRef.current = null;
    }
    if (localStartTimerRef.current) {
      clearTimeout(localStartTimerRef.current);
      localStartTimerRef.current = null;
    }
    setPreviewLoading(false);
    setPreviewView(null);
    setPreview('idle');
  }, []);

  const stopPreview = useCallback(() => {
    releasePreview(stopSelf);
    stopSelf();
  }, [stopSelf]);

  useEffect(() => {
    return () => {
      releasePreview(stopSelf);
      stopSelf();
    };
  }, [stopSelf]);

  const beginIframePreview = useCallback(() => {
    if (!previewSrc) {
      // Neither a local clip nor the MEGA embed is available: no preview.
      stopSelf();
      return;
    }
    activeRef.current = true;
    acquirePreview(stopSelf);
    setPreviewLoading(false);
    setPreviewView({ kind: 'iframe' });
    setPreview('active');
  }, [previewSrc, stopSelf]);

  /**
   * A local clip failed before playback (media error, autoplay rejection, or
   * startup watchdog). Stop its loader immediately; use the legacy embed when
   * one exists, otherwise return to the thumbnail.
   */
  const failLocalPreview = useCallback(() => {
    if (!activeRef.current) return;
    setPreviewLoading(false);
    if (previewSrc) beginIframePreview();
    else stopSelf();
  }, [beginIframePreview, previewSrc, stopSelf]);

  const beginLocalPreview = useCallback((url: string) => {
    activeRef.current = true;
    acquirePreview(stopSelf);
    setPreviewLabel('Loading preview');
    setPreviewLoading(true);
    setPreviewView({ kind: 'local', url });
    setPreview('active');

    // The indicator stays up until the clip actually plays. If the media
    // element never reaches `playing`, fail over instead of spinning forever.
    if (localStartTimerRef.current) {
      clearTimeout(localStartTimerRef.current);
    }
    localStartTimerRef.current = setTimeout(() => {
      localStartTimerRef.current = null;
      failLocalPreview();
    }, LOCAL_PREVIEW_START_TIMEOUT_MS);
  }, [failLocalPreview, stopSelf]);

  const handlePreviewPlaying = useCallback(() => {
    if (!activeRef.current) return;
    if (localStartTimerRef.current) {
      clearTimeout(localStartTimerRef.current);
      localStartTimerRef.current = null;
    }
    setPreviewLoading(false);
  }, []);

  const handlePreviewError = useCallback(() => {
    if (localStartTimerRef.current) {
      clearTimeout(localStartTimerRef.current);
      localStartTimerRef.current = null;
    }
    failLocalPreview();
  }, [failLocalPreview]);

  /**
   * Activate the preview: the local hover clip wins whenever meta says it is
   * ready (cached per page). Otherwise wait, bounded, for the background
   * generation to finish — the meta endpoint admits the job and answers
   * `generating` immediately, so this is a cheap poll, not a blocked fetch.
   * If a legacy MEGA embed exists, it appears after a short 2.5 s grace and
   * is replaced by the local clip when ready; terminal states/timeouts fall
   * back immediately, preserving the pre-Phase-5 behavior.
   */
  const startPreview = useCallback(() => {
    activeRef.current = true;
    acquirePreview(stopSelf);

    const cached = cachedCardPreviewMeta(id);
    if (cached?.hoverUrl) {
      // Known-ready: mount immediately; the loader stays until `playing`.
      beginLocalPreview(cached.hoverUrl);
      return;
    }
    if (metaInFlightRef.current) return;
    setPreviewLabel('Preparing preview');
    setPreviewLoading(true);
    metaInFlightRef.current = true;
    const runId = ++runIdRef.current;
    const stillActive = () => activeRef.current && runIdRef.current === runId;
    void (async () => {
      const first = await resolveCardHoverPreviewState(id);
      let url = first.url;
      let iframeShown = false;
      if (!url && stillActive()) setPreviewLabel(previewStatusLabel(first.status));

      // Cold local generation: cards that already have a MEGA embed keep a
      // short fallback path instead of waiting the whole 30 s poll window.
      // Polling continues; if the local clip arrives it replaces the iframe.
      if (!url && previewSrc && stillActive()) {
        iframeFallbackRef.current = setTimeout(() => {
          iframeFallbackRef.current = null;
          if (!stillActive()) return;
          iframeShown = true;
          beginIframePreview();
        }, 2500);
      }

      if (!url && stillActive()) {
        const waited = await waitForCardHoverPreviewDetailed(id, stillActive, {
          onStatus: (status) => {
            if (stillActive()) setPreviewLabel(previewStatusLabel(status));
          },
        });
        url = waited.url;
      }
      if (iframeFallbackRef.current) {
        clearTimeout(iframeFallbackRef.current);
        iframeFallbackRef.current = null;
      }
      if (runIdRef.current === runId) metaInFlightRef.current = false;
      if (!stillActive()) return; // pointer left / another card took over
      if (url) {
        beginLocalPreview(url);
      } else if (iframeShown) {
        setPreviewLoading(false);
      } else {
        // Failed / unsupported / timed out: never leave an endless spinner.
        stopPreview();
      }
    })();
  }, [beginIframePreview, beginLocalPreview, id, previewSrc, stopPreview, stopSelf]);

  // Scheduling is unconditional now: a local preview exists for videos that
  // have no MEGA embed URL (private sources) too. Cards without either kind
  // of preview simply resolve meta once (cached) and show nothing.
  const scheduleHoverPreview = useCallback(() => {
    if (activeRef.current) return;
    hoverTimerRef.current = setTimeout(startPreview, previewDelayMs());
  }, [startPreview]);

  function handleMouseEnter() {
    // A tap on a touch device can synthesize mouseenter; ignore that window.
    if (Date.now() < touchGuardUntilRef.current) return;
    scheduleHoverPreview();
  }
  function handleMouseLeave() {
    stopPreview();
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (e.pointerType !== 'touch') return;
    touchGuardUntilRef.current = Date.now() + 1500;
  }

  // Latest start/stop for the IntersectionObserver, which is installed once.
  const mobileStartRef = useRef(startPreview);
  const mobileStopRef = useRef(stopPreview);
  useEffect(() => {
    mobileStartRef.current = startPreview;
    mobileStopRef.current = stopPreview;
  }, [startPreview, stopPreview]);

  /**
   * Phase 5.1 mobile previews: when a card is at least ~60% visible and stays
   * that way briefly, it becomes a candidate for the single autoplay slot.
   * The coordinator picks the most prominent candidate, so scrolling a grid
   * never plays several videos at once. Only installed on devices without a
   * conventional hover pointer, and suppressed for reduced-motion/save-data.
   */
  useEffect(() => {
    const el = cardRef.current;
    if (!el || typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const connection = (
      navigator as Navigator & { connection?: { saveData?: boolean } }
    ).connection;
    if (connection?.saveData) return;

    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    let reported = false;

    const clearDwell = () => {
      if (dwellTimer) {
        clearTimeout(dwellTimer);
        dwellTimer = null;
      }
    };

    const unregister = () => {
      clearDwell();
      if (reported) {
        reported = false;
        removeMobileCandidate(mobileId);
      }
    };

    const handlers = {
      activate: () => mobileStartRef.current(),
      deactivate: () => {
        reported = false;
        mobileStopRef.current();
      },
    };

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        const ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
        if (ratio >= MOBILE_VISIBILITY_THRESHOLD) {
          if (reported) {
            reportMobileVisibility(mobileId, ratio, handlers);
          } else if (!dwellTimer) {
            dwellTimer = setTimeout(() => {
              dwellTimer = null;
              reported = true;
              reportMobileVisibility(mobileId, ratio, handlers);
            }, MOBILE_DWELL_MS);
          }
        } else {
          unregister();
          // Leaving the viewport stops this card's preview immediately; a
          // durable generation job is never cancelled by the client.
          if (activeRef.current) mobileStopRef.current();
        }
      },
      { threshold: [0, MOBILE_VISIBILITY_THRESHOLD, 0.75, 1] },
    );
    observer.observe(el);

    return () => {
      unregister();
      observer.disconnect();
    };
  }, [mobileId]);

  function openVideo() {
    // Internal navigation: always the CURRENT tab. `window.open(..., '_blank')`
    // here was the source of every card opening a duplicate tab/window.
    router.push(`/video/${slug}`);
  }

  function handleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('a')) return;
    // The ⋮ action menu manages its own clicks - never open the video.
    if ((e.target as HTMLElement).closest('[data-card-menu]')) return;
    e.preventDefault();
    openVideo();
  }

  const showPreview = preview === 'active';
  const displayTitle = title || megaFilename.replace(/\.[^.]+$/, '');
  const durationLabel = formatDuration(duration);

  return (
    <div
      ref={cardRef}
      className="group relative cursor-pointer select-none"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handlePointerDown}
      onPointerCancel={handlePointerDown}
      onClick={handleClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest?.('[data-card-menu]')) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openVideo();
        }
      }}
      aria-label={displayTitle}
      data-previewable={previewSrc ? undefined : 'false'}
      {...(feedSource ? { 'data-feed-source': feedSource } : {})}
    >
      <VideoCardMenu
        videoId={id}
        creator={creator}
        isPrivate={isPrivate}
        megaFilename={megaFilename}
        title={title}
      />
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-surface transition-[transform,box-shadow] duration-200 group-hover:-translate-y-0.5 group-hover:shadow-[0_16px_40px_-16px_var(--shadow-color)]">
        {thumbnail ? (
          <ThumbImage
            src={thumbnail}
            loading={priority ? 'eager' : 'lazy'}
            className={`transition-opacity duration-200 ${
              showPreview ? 'opacity-0' : 'opacity-100 group-hover:opacity-95'
            }`}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface-raised">
            <FilmIcon className="h-10 w-10 text-muted-light" />
          </div>
        )}

        {showPreview && previewView?.kind === 'local' && (
          <>
            <PreviewVideo
              src={previewView.url}
              className="absolute inset-0 h-full w-full bg-black object-contain"
              onPlaying={handlePreviewPlaying}
              onError={handlePreviewError}
            />
            <div
              className="absolute inset-0 z-10"
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                openVideo();
              }}
            />
          </>
        )}

        {showPreview && previewView?.kind === 'iframe' && previewSrc && (
          <>
            <iframe
              key={id}
              src={previewSrc}
              title={displayTitle}
              allow="autoplay; fullscreen"
              allowFullScreen
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full border-0 bg-black"
              onError={() => stopPreview()}
            />
            <div
              className="absolute inset-0 z-10"
              aria-hidden
              onClick={(e) => {
                e.stopPropagation();
                openVideo();
              }}
            />
          </>
        )}

        {previewLoading && (
          <div
            data-preview-loading
            role="status"
            aria-label="Loading preview"
            className="pointer-events-none absolute right-12 top-2 z-20 flex items-center gap-1.5 rounded-full border border-white/15 bg-black/75 px-2 py-1 text-[10px] font-medium leading-none text-white shadow-[0_2px_10px_rgba(0,0,0,0.45)] backdrop-blur-[2px]"
          >
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-white/30 border-t-white"
            />
            <span className="whitespace-nowrap">{previewLabel}</span>
          </div>
        )}

        {durationLabel && !showPreview && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/85 px-1.5 py-0.5 text-xs font-medium tabular-nums text-white">
            {durationLabel}
          </span>
        )}
      </div>

      <div className="mt-3 flex gap-3">
        {creator ? (
          <Link
            href={`/creator/${creator.slug}`}
            onClick={(e) => e.stopPropagation()}
            aria-label={`More videos by ${creator.name}`}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent hover:bg-accent hover:text-white"
          >
            {creator.name.charAt(0).toUpperCase()}
          </Link>
        ) : (
          <span
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-raised"
          >
            <svg className="h-5 w-5 text-muted-light" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </span>
        )}

        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-[15px] font-medium leading-snug text-foreground">
            <Link
              href={`/video/${slug}`}
              data-video-title-link
              onClick={(e) => e.stopPropagation()}
              className="hover:text-accent"
            >
              {displayTitle}
            </Link>
          </h3>
          {creator ? (
            <Link
              href={`/creator/${creator.slug}`}
              onClick={(e) => e.stopPropagation()}
              className="mt-1 block w-fit max-w-full truncate text-[13px] text-muted hover:text-foreground"
            >
              {creator.name}
            </Link>
          ) : (
            <span className="mt-1 block text-[13px] text-muted">Unknown Creator</span>
          )}
        </div>
      </div>
    </div>
  );
}