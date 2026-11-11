'use client';

import { useEffect, useRef } from 'react';

/**
 * Phase 5: local hover-preview video element.
 *
 * A small muted looping `<video>` overlaying the card thumbnail — no iframe,
 * no full player. Playback starts on `canplay` (muted autoplay is always
 * policy-compatible); unmount pauses/stops. `preview-manager` guarantees at
 * most one of these is mounted at any time.
 */
export function PreviewVideo({
  src,
  className,
  onPlaying,
  onError,
}: {
  src: string;
  className?: string;
  /** Fired only once the browser has actually started playback. */
  onPlaying?: () => void;
  /** Fired for media/decode failures or a rejected autoplay request. */
  onError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    const play = () => {
      if (cancelled) return;
      void video.play().catch(() => {
        // Muted autoplay should always succeed; if it does not, report it so
        // the card can stop the loading indicator and use its fallback.
        if (!cancelled) onError?.();
      });
    };
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      play();
    } else {
      video.addEventListener('canplay', play, { once: true });
    }
    return () => {
      cancelled = true;
      video.removeEventListener('canplay', play);
      video.pause();
    };
  }, [src, onError]);

  return (
    <video
      ref={videoRef}
      src={src}
      muted
      loop
      playsInline
      preload="auto"
      disableRemotePlayback
      onPlaying={onPlaying}
      onError={onError}
      className={className}
    />
  );
}
