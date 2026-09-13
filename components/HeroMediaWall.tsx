'use client';

import { useEffect, useRef, type CSSProperties } from 'react';
import { BookmarkIcon, HistoryIcon, PlayIcon, SearchIcon } from '@/components/icons';

/**
 * The landing hero centerpiece: a "media wall" in perspective.
 *
 * A large player surface anchors the composition; library, continue
 * watching, and search panels float around it at different depths.
 * Pointer position tilts the stage and translates layers at different
 * rates (multi-speed depth); touch devices and reduced-motion users get
 * the static composed wall. Decorative - hidden from assistive tech.
 *
 * Layers carry --depth (px of travel) and --enter-delay (entrance
 * stagger). All motion is transform/opacity only.
 */

function usePointerParallax(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const stage = ref.current;
    if (!stage) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia?.('(pointer: coarse)').matches) return;

    let raf = 0;
    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;

    function tick() {
      cx += (tx - cx) * 0.08;
      cy += (ty - cy) * 0.08;
      stage!.style.setProperty('--mpx', cx.toFixed(3));
      stage!.style.setProperty('--mpy', cy.toFixed(3));
      if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) {
        raf = requestAnimationFrame(tick);
      } else {
        raf = 0;
      }
    }

    function onMove(e: PointerEvent) {
      const rect = stage!.getBoundingClientRect();
      tx = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width - 0.5) * 2));
      ty = Math.max(-1, Math.min(1, ((e.clientY - rect.top) / rect.height - 0.5) * 2));
      if (!raf) raf = requestAnimationFrame(tick);
    }

    function onLeave() {
      tx = 0;
      ty = 0;
      if (!raf) raf = requestAnimationFrame(tick);
    }

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
    };
  }, [ref]);
}

function Thumb({ className = '', seed }: { className?: string; seed: number }) {
  // Abstract "frames": alternating tonal blocks suggest video stills
  // without faking real content.
  const tones = ['bg-surface-overlay', 'bg-surface-raised', 'bg-border'];
  return (
    <div className={`relative aspect-video overflow-hidden rounded-lg ${tones[seed % tones.length]} ${className}`}>
      <span
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            seed % 2 === 0
              ? 'radial-gradient(circle at 30% 70%, rgba(255,0,51,0.22), transparent 60%)'
              : 'radial-gradient(circle at 70% 30%, rgba(255,255,255,0.08), transparent 55%)',
        }}
      />
      <span aria-hidden className="absolute bottom-1.5 right-1.5 rounded bg-black/85 px-1 py-px text-[10px] font-medium tabular-nums text-white">
        {['12:40', '04:17', '48:02', '22:31', '09:55', '1:04:12'][seed % 6]}
      </span>
    </div>
  );
}

export function HeroMediaWall() {
  const ref = useRef<HTMLDivElement>(null);
  usePointerParallax(ref);

  return (
    <div ref={ref} aria-hidden className="mt-stage relative mx-auto w-full max-w-md select-none lg:max-w-none">
      <div className="mt-tilt relative" style={{ transform: 'rotateX(2deg)' }}>
        {/* Back layer: library grid panel (deepest, slowest) */}
        <div
          className="mt-depth mt-enter absolute -top-8 left-2 right-10 rounded-2xl border border-border bg-surface-raised p-3 sm:left-6 sm:right-16"
          style={{ '--depth': 10, '--enter-delay': '350ms' } as CSSProperties}
        >
          <p className="flex items-center gap-1.5 px-1 pb-2 text-[11px] font-medium text-muted">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            Your library
          </p>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Thumb key={i} seed={i} />
            ))}
          </div>
        </div>

        {/* Anchor: the player surface */}
        <div
          className="mt-depth mt-enter mt-wall-shadow relative rounded-2xl border border-border bg-surface p-3"
          style={{ '--depth': 22, '--enter-delay': '120ms' } as CSSProperties}
        >
          <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
            <span
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse 70% 90% at 50% 110%, rgba(255,0,51,0.28), transparent 60%)',
              }}
            />
            <span className="mt-rec absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-1 text-[10px] font-semibold tracking-wide text-white">
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              NOW SHOWING
            </span>
            <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-accent shadow-[0_0_40px_rgba(255,0,51,0.5)]">
              <PlayIcon className="h-6 w-6 text-white" />
            </span>
            <span className="absolute inset-x-3 bottom-3">
              <span className="relative block h-1 overflow-hidden rounded-full bg-white/25">
                <span className="block h-full w-1/3 rounded-full bg-accent" />
                <span className="mt-rail-sheen absolute inset-y-0 w-1/4 bg-white/40" />
              </span>
              <span className="mt-1.5 flex justify-between text-[10px] font-medium tabular-nums text-white/80">
                <span>24:18</span>
                <span>1:12:40</span>
              </span>
            </span>
          </div>
          <div className="flex items-center gap-3 px-1 pb-1 pt-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
              M
            </span>
            <div className="min-w-0 flex-1">
              <div className="h-3 w-3/4 rounded bg-surface-overlay" />
              <div className="mt-1.5 h-2.5 w-1/3 rounded bg-surface-overlay" />
            </div>
          </div>
        </div>

        {/* Mid layer: continue watching rail */}
        <div
          className="mt-depth mt-drift-a mt-enter mt-wall-shadow absolute -bottom-8 left-0 w-40 rounded-2xl border border-border bg-surface-raised p-3 sm:-bottom-10 sm:-left-6 sm:w-48"
          style={{ '--depth': 34, '--enter-delay': '480ms' } as CSSProperties}
        >
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
            <HistoryIcon className="h-3.5 w-3.5" />
            Continue watching
          </p>
          <div className="mt-2 space-y-2.5">
            {[72, 38].map((w, i) => (
              <div key={w}>
                <Thumb seed={i + 2} />
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-surface-overlay">
                  <span className="block h-full rounded-full bg-accent" style={{ width: `${w}%` }} />
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Front layer: search + saved chips (shallowest, fastest) */}
        <div
          className="mt-depth mt-drift-b mt-enter absolute right-0 top-[38%] space-y-2 sm:-right-4"
          style={{ '--depth': 46, '--enter-delay': '600ms' } as CSSProperties}
        >
          <p className="mt-wall-shadow flex items-center gap-2 rounded-full border border-border bg-surface-raised py-2 pl-3 pr-4 text-xs font-medium">
            <SearchIcon className="h-3.5 w-3.5 text-muted" />
            midnight drive
          </p>
          <p className="mt-wall-shadow ml-6 flex w-fit items-center gap-2 rounded-full border border-border bg-surface-raised py-2 pl-3 pr-4 text-xs font-medium">
            <BookmarkIcon className="h-3.5 w-3.5 text-accent" />
            Saved to Watchlist
          </p>
        </div>
      </div>
    </div>
  );
}
