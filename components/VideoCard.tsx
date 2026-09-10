'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { tryMegaFileUrlToPreviewUrl } from '@/lib/mega/embed';
import { acquirePreview, releasePreview } from '@/lib/preview-manager';
import { previewDelayMs } from '@/lib/config';

interface VideoCardProps {
  id: number;
  slug: string;
  title: string;
  megaUrl: string | null;
  megaFilename: string;
  thumbnail: string | null;
  creator: { slug: string; name: string } | null;
  priority?: boolean;
}

type PreviewState = 'idle' | 'pending' | 'active';

export function VideoCard({
  id,
  slug,
  title,
  megaUrl,
  megaFilename,
  thumbnail,
  creator,
  priority = false,
}: VideoCardProps) {
  const [preview, setPreview] = useState<PreviewState>('idle');
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const suppressClickRef = useRef(false);
  // Set while a touch interaction is (or was recently) on this card. Browsers
  // fire a synthetic mouseenter/mousemove/mouseover sequence after touchend
  // for compatibility; without this guard the synthetic mouseenter re-arms a
  // hover preview right after the user lifts their finger.
  const touchGuardUntilRef = useRef(0);

  // Non-throwing: a malformed or missing link in the catalog must degrade this
  // card only (no preview), never crash the whole page. Private (synced)
  // videos have no public preview and thus no previewSrc.
  const previewSrc = megaUrl ? tryMegaFileUrlToPreviewUrl(megaUrl) : null;

  // Stops this card's own preview (timers + state) without touching the
  // manager slot; the manager calls this when replacing an active preview.
  const stopSelf = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
    activeRef.current = false;
    setPreview('idle');
  }, []);

  // Stops this card AND releases the manager slot (used on mouseleave etc.).
  const stopPreview = useCallback(() => {
    releasePreview(stopSelf);
    stopSelf();
  }, [stopSelf]);

  // Unmount safety: never leave a player running.
  useEffect(() => {
    return () => {
      releasePreview(stopSelf);
      stopSelf();
    };
  }, [stopSelf]);

  const startPreview = useCallback(() => {
    activeRef.current = true;
    acquirePreview(stopSelf);
    setPreview('active');
  }, [stopSelf]);

  const scheduleHoverPreview = useCallback(() => {
    if (activeRef.current || !previewSrc) return;
    hoverTimerRef.current = setTimeout(startPreview, previewDelayMs());
  }, [startPreview, previewSrc]);

  const scheduleTouchPreview = useCallback(() => {
    if (activeRef.current || !previewSrc) return;
    touchTimerRef.current = setTimeout(startPreview, previewDelayMs());
  }, [startPreview, previewSrc]);

  // Desktop hover. Ignored shortly after a touch interaction: browsers
  // synthesize mouse events after touchend, which would otherwise re-arm the
  // preview right after a long-press ended or a quick tap navigated.
  function handleMouseEnter() {
    if (Date.now() < touchGuardUntilRef.current) return;
    scheduleHoverPreview();
  }
  function handleMouseLeave() {
    stopPreview();
  }

  // Mobile long-press via Pointer Events. A quick tap must not preview.
  function handlePointerDown(e: React.PointerEvent) {
    if (e.pointerType !== 'touch') return;
    // Synthetic mouse events after touchend are suppressed for a grace
    // period covering the post-touch compatibility sequence.
    touchGuardUntilRef.current = Date.now() + 1500;
    scheduleTouchPreview();
  }
  function handlePointerUp(e: React.PointerEvent) {
    if (e.pointerType !== 'touch') return;
    if (activeRef.current) {
      // A long-press preview was shown: releasing the finger should return
      // to the thumbnail, not navigate.
      suppressClickRef.current = true;
    }
    touchGuardUntilRef.current = Date.now() + 1500;
    stopPreview();
  }
  function handlePointerCancel(e: React.PointerEvent) {
    if (e.pointerType !== 'touch') return;
    touchGuardUntilRef.current = Date.now() + 1500;
    stopPreview();
  }
  // If the user starts scrolling while holding, cancel the pending preview.
  function handleTouchMove() {
    if (touchTimerRef.current || activeRef.current) {
      stopPreview();
    }
  }

  function openVideo() {
    window.open(`/video/${slug}`, '_blank', 'noopener');
  }

  // Clicking the card opens our internal video page in a new tab.
  function handleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('a')) return; // creator link inside
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    e.preventDefault();
    openVideo();
  }

  const showPreview = preview === 'active';

  return (
    <div
      className="group cursor-pointer select-none"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onTouchMove={handleTouchMove}
      onClick={handleClick}
      role="link"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openVideo();
        }
      }}
      aria-label={title}
      data-previewable={previewSrc ? undefined : 'false'}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border bg-black">
        {thumbnail ? (
          // Thumbnail stays mounted underneath the preview iframe so the
          // card never shows an empty black frame if the player fails.
          <img
            src={thumbnail}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${
              showPreview ? 'opacity-0' : 'opacity-100'
            }`}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-card text-muted">
            <svg className="h-12 w-12 opacity-60" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}

        {showPreview && previewSrc && (
          <>
            <iframe
              key={id}
              src={previewSrc}
              title={title}
              allow="autoplay; fullscreen"
              allowFullScreen
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full border-0 bg-black"
              onError={() => stopPreview()}
            />
            {/* Click-catcher: while previewing, clicks open the video page
                instead of falling through into the MEGA iframe. */}
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

        {preview === 'pending' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-muted/40 border-t-accent" />
          </div>
        )}
      </div>

      <div className="mt-2 px-0.5">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug">
          {title || megaFilename.replace(/\.[^.]+$/, '')}
        </h3>
        {creator ? (
          <Link
            href={`/creator/${creator.slug}`}
            onClick={(e) => e.stopPropagation()}
            className="mt-0.5 inline-block text-xs text-muted transition-colors hover:text-accent"
          >
            {creator.name}
          </Link>
        ) : (
          <span className="mt-0.5 inline-block text-xs text-muted">Unknown Creator</span>
        )}
      </div>
    </div>
  );
}