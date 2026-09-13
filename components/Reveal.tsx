'use client';

import { useEffect, useRef, type CSSProperties } from 'react';

/**
 * Scroll reveal: children fade + rise once when entering the viewport.
 * Single IntersectionObserver per instance, disconnects after reveal.
 * Static (visible) under reduced motion via CSS, and when IO is
 * unavailable content renders visible.
 */
export function Reveal({
  children,
  delay = 0,
  className = '',
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'section' | 'li' | 'span';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Arm the hidden state from JS only: SSR / no-JS output stays visible.
    el.classList.add('armed');
    if (typeof IntersectionObserver === 'undefined') {
      el.classList.add('is-visible');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            io.disconnect();
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Tag is a fixed union of intrinsics; cast to div for the ref type
  // while keeping the runtime element.
  const TagForRef = Tag as 'div';
  return (
    <TagForRef
      ref={ref}
      style={{ '--reveal-delay': `${delay}ms` } as CSSProperties}
      className={`mt-reveal ${className}`}
    >
      {children}
    </TagForRef>
  );
}
