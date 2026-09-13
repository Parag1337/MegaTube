'use client';

/**
 * One YouTube-style ⋮ action menu per video card: Add/Remove Watchlist,
 * Save/Unsave, and Change Creator (private/owned videos only - the API
 * enforces ownership regardless). A single permanent-looking button opens
 * the menu; nothing else sits over the thumbnail.
 *
 * Menu clicks never open the video: every pointer/click event inside the
 * menu is stopped, and the parent card ignores events from [data-card-menu]
 * as a second guard. Works with mouse and touch.
 */

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import VideoCreatorControl from '@/app/video/[slug]/VideoCreatorControl';
import { DotsIcon } from '@/components/icons';
import { startDownload } from '@/components/downloadClient';
import { useSession } from '@/components/useSession';

interface VideoCardMenuProps {
  videoId: number;
  creator: { slug: string; name: string } | null;
  /** True for owned private videos - gates the Change Creator option. */
  isPrivate?: boolean;
}

export function VideoCardMenu({ videoId, creator, isPrivate = false }: VideoCardMenuProps) {
  const { user, loading } = useSession();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [watchlisted, setWatchlisted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [signedIn, setSignedIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside tap/click or Escape (same pattern as the shell menus).
  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  // Load membership lazily on first open so grids don't fire 2N requests.
  useEffect(() => {
    if (!open || loaded || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const [w, s] = await Promise.all([
          fetch(`/api/watchlist/${videoId}`),
          fetch(`/api/saved/${videoId}`),
        ]);
        if (w.status === 401 || s.status === 401) {
          if (!cancelled) setSignedIn(false);
          return;
        }
        if (!w.ok || !s.ok) throw new Error('Could not load list status.');
        const [wd, sd] = await Promise.all([w.json(), s.json()]);
        if (!cancelled) {
          setWatchlisted(Boolean(wd.onWatchlist));
          setSaved(Boolean(sd.saved));
          setLoaded(true);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Something went wrong.');
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, loaded, user, videoId]);

  async function toggle(kind: 'watchlist' | 'saved') {
    const active = kind === 'watchlist' ? watchlisted : saved;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/${kind}/${videoId}`, { method: active ? 'DELETE' : 'POST' });
      if (res.status === 401) {
        setSignedIn(false);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((data as { error?: string } | null)?.error || 'Request failed.');
      }
      if (kind === 'watchlist') setWatchlisted(!active);
      else setSaved(!active);
      // Collection pages are server-rendered: refresh their data without a
      // full page reload so removals disappear from the grid.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setDownloading(true);
    setError('');
    try {
      const result = await startDownload(videoId);
      if (result.started) {
        setOpen(false);
      } else if (result.reason === 'busy') {
        // Double-click collapsed into the in-flight download - just close.
        setOpen(false);
      } else {
        setError(result.message ?? 'Could not start the download.');
      }
    } finally {
      setDownloading(false);
    }
  }

  const itemCls =
    'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-surface-hover disabled:opacity-50';

  return (
    <div
      ref={ref}
      data-card-menu
      className="absolute right-2 top-2 z-30"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setError('');
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Video actions"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-black/70 text-white transition-colors hover:bg-black/90 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 md:group-focus-within:opacity-100"
      >
        <DotsIcon className="h-5 w-5" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Video actions"
          className="absolute right-0 top-10 z-40 w-56 overflow-hidden rounded-xl border border-border bg-surface-raised py-1.5 shadow-2xl shadow-black/60"
        >
          {loading ? (
            <span aria-hidden className={`${itemCls} text-muted`}>
              Loading…
            </span>
          ) : !user || !signedIn ? (
            <Link
              role="menuitem"
              href="/login"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
              }}
              className={itemCls}
            >
              Sign in to use lists
            </Link>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => toggle('watchlist')}
                className={itemCls}
              >
                {watchlisted ? 'Remove from Watchlist' : 'Add to Watchlist'}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => toggle('saved')}
                className={itemCls}
              >
                {saved ? 'Unsave video' : 'Save video'}
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={busy || downloading}
                onClick={download}
                className={itemCls}
              >
                {downloading ? 'Preparing download…' : 'Download'}
              </button>
              {isPrivate && (
                <VideoCreatorControl
                  videoId={videoId}
                  currentCreator={
                    creator ? { id: 0, name: creator.name, slug: creator.slug, avatar: null } : null
                  }
                  trigger={(openDialog) => (
                    <button
                      type="button"
                      role="menuitem"
                      // NOTE: the menu stays open underneath the dialog - closing
                      // it first would unmount this control and its dialog.
                      onClick={() => openDialog()}
                      className={itemCls}
                    >
                      Change creator
                    </button>
                  )}
                />
              )}
              {error && (
                <p role="alert" className="px-4 py-2 text-xs leading-relaxed text-destructive">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
