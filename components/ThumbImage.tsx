'use client';

import { useEffect, useRef, useState } from 'react';
import { isApproximatelySixteenByNine } from '@/lib/thumbs/display';

interface ThumbImageProps {
  src: string;
  loading?: 'lazy' | 'eager';
  className?: string;
}

/**
 * Final thumbnail rule, one image layer:
 *
 * - The card is always fixed 16:9 (the container owns that).
 * - Until the real size is known the image covers the card - correct
 *   immediately for square/portrait, and pixel-identical to contain for an
 *   exact 16:9 frame, so there is no flash or layout shift.
 * - Once loaded, an approximately-16:9 frame switches to contain: the whole
 *   image, no crop, no zoom. Anything else keeps covering (crop OK).
 */
export function ThumbImage({ src, loading = 'lazy', className = '' }: ThumbImageProps) {
  const [contain, setContain] = useState(false);
  const ref = useRef<HTMLImageElement>(null);
  // An eager/cached image can finish before React attaches onLoad - check
  // the already-complete case on mount as well.
  useEffect(() => {
    const img = ref.current;
    if (
      img &&
      img.complete &&
      img.naturalWidth > 0 &&
      isApproximatelySixteenByNine(img.naturalWidth, img.naturalHeight)
    ) {
      setContain(true);
    }
  }, [src]);
  const check = (img: HTMLImageElement) => {
    if (isApproximatelySixteenByNine(img.naturalWidth, img.naturalHeight)) {
      setContain(true);
    }
  };
  return (
    <img
      ref={ref}
      src={src}
      alt=""
      loading={loading}
      decoding="async"
      draggable={false}
      onLoad={(e) => check(e.currentTarget)}
      className={`absolute inset-0 h-full w-full ${contain ? 'object-contain' : 'object-cover'}${className ? ` ${className}` : ''}`}
    />
  );
}
