'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { tryMegaFileUrlToPreviewUrl } from '@/lib/mega/embed';
import { acquirePreview, releasePreview } from '@/lib/preview-manager';
import { previewDelayMs } from '@/lib/config';
import { formatDuration } from '@/components/format';
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
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const suppressClickRef = useRef(false);
  const touchGuardUntilRef = useRef(0);

  const previewSrc = megaUrl ? tryMegaFileUrlToPreviewUrl(megaUrl) : null;

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

  function handleMouseEnter() {
    if (Date.now() < touchGuardUntilRef.current) return;
    scheduleHoverPreview();
  }
  function handleMouseLeave() {
    stopPreview();
  }

  function handlePointerDown(e: React.PointerEvent) {
    if (e.pointerType !== 'touch') return;
    touchGuardUntilRef.current = Date.now() + 1500;
    scheduleTouchPreview();
  }
  function handlePointerUp(e: React.PointerEvent) {
    if (e.pointerType !== 'touch') return;
    if (activeRef.current) {
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
  function handleTouchMove() {
    if (touchTimerRef.current || activeRef.current) {
      stopPreview();
    }
  }

  function openVideo() {
    window.open(`/video/${slug}`, '_blank', 'noopener');
  }

  function handleClick(e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest('a')) return;
    // The ⋮ action menu manages its own clicks - never open the video.
    if ((e.target as HTMLElement).closest('[data-card-menu]')) return;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    e.preventDefault();
    openVideo();
  }

  const showPreview = preview === 'active';
  const displayTitle = title || megaFilename.replace(/\.[^.]+$/, '');
  const durationLabel = formatDuration(duration);

  return (
    <div
      className="group relative cursor-pointer select-none"
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
      <VideoCardMenu videoId={id} creator={creator} isPrivate={isPrivate} />
      <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-surface">
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
            <svg className="h-10 w-10 text-muted-light" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}

        {showPreview && previewSrc && (
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

        {preview === 'pending' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-muted-light/40 border-t-accent" />
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
            {displayTitle}
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