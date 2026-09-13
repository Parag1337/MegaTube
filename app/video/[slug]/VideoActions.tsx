'use client';

/**
 * Action row below the player: Watchlist toggle, Save toggle, Download.
 * Watchlist/Save reuse the existing /api/watchlist|saved/[videoId] contracts
 * (same as the card menu); Download calls the single shared startDownload
 * helper, i.e. the same GET /api/download/[videoId] endpoint as the menu.
 */

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { BookmarkIcon, DownloadIcon } from '@/components/icons';
import { startDownload } from '@/components/downloadClient';

export function VideoActions({ videoId }: { videoId: number }) {
  const [watchlisted, setWatchlisted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [signedIn, setSignedIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');

  // Membership is loaded once on mount (same lazy pattern as the card menu).
  useEffect(() => {
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
        if (!w.ok || !s.ok) return;
        const [wd, sd] = await Promise.all([w.json(), s.json()]);
        if (!cancelled) {
          setWatchlisted(Boolean(wd.onWatchlist));
          setSaved(Boolean(sd.saved));
        }
      } catch {
        // Lists stay in their default (additive) state; actions report errors.
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [videoId]);

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
      if (!result.started && result.reason === 'error') {
        setError(result.message ?? 'Could not start the download.');
      }
    } finally {
      setDownloading(false);
    }
  }

  if (!signedIn) return null;

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Video actions">
        <Button
          variant={watchlisted ? 'primary' : 'secondary'}
          size="sm"
          disabled={busy}
          onClick={() => toggle('watchlist')}
          ariaLabel={watchlisted ? 'Remove from Watchlist' : 'Add to Watchlist'}
        >
          <BookmarkIcon className="h-4 w-4" />
          {watchlisted ? 'Watchlisted' : 'Watchlist'}
        </Button>
        <Button
          variant={saved ? 'primary' : 'secondary'}
          size="sm"
          disabled={busy}
          onClick={() => toggle('saved')}
          ariaLabel={saved ? 'Unsave video' : 'Save video'}
        >
          {saved ? 'Saved' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={downloading}
          onClick={download}
          ariaLabel="Download original file"
        >
          <DownloadIcon className="h-4 w-4" />
          {downloading ? 'Preparing…' : 'Download'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
