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
export function PreviewVideo({ src, className }: { src: string; className?: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    const play = () => {
      if (cancelled) return;
      void video.play().catch(() => {
        // Autoplay of a muted element cannot be blocked; ignore defensively.
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
  }, [src]);

  return (
    <video
      ref={videoRef}
      src={src}
      muted
      loop
      playsInline
      preload="auto"
      disableRemotePlayback
      className={className}
    />
  );
}
