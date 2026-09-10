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
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    e.preventDefault();
    openVideo();
  }

  const showPreview = preview === 'active';
  const displayTitle = title || megaFilename.replace(/\.[^.]+$/, '');

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
      aria-label={displayTitle}
      data-previewable={previewSrc ? undefined : 'false'}
    >
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
        {thumbnail ? (
          <img
            src={thumbnail}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
            className={`h-full w-full object-cover transition-opacity duration-200 ${
              showPreview ? 'opacity-0' : 'opacity-100'
            }`}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-surface">
            <svg className="h-12 w-12 text-muted-light" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
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

        {/* Duration indicator placeholder - could be added when duration data is available */}
        <div className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Duration would go here */}
        </div>
      </div>

      <div className="mt-3 flex gap-3">
        {/* Channel avatar placeholder */}
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface">
          {creator ? (
            <span className="text-sm font-medium text-accent">
              {creator.name.charAt(0).toUpperCase()}
            </span>
          ) : (
            <svg className="h-5 w-5 text-muted-light" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-2 text-sm font-medium leading-tight text-foreground group-hover:text-foreground">
            {displayTitle}
          </h3>
          {creator ? (
            <Link
              href={`/creator/${creator.slug}`}
              onClick={(e) => e.stopPropagation()}
              className="mt-1 block text-xs text-muted hover:text-foreground"
            >
              {creator.name}
            </Link>
          ) : (
            <span className="mt-1 block text-xs text-muted">Unknown Creator</span>
          )}
        </div>
      </div>
    </div>
  );
}