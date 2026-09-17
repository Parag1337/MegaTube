'use client';

/**
 * Action row below the player: Watchlist toggle, Save toggle, Download,
 * plus owner-only Rename and Delete video (same dialogs/endpoints as the
 * card menu: POST /api/videos/[videoId]/rename, DELETE /api/videos/[id]).
 * Watchlist/Save reuse the existing /api/watchlist|saved/[videoId] contracts
 * (same as the card menu); Download calls the single shared startDownload
 * helper, i.e. the same GET /api/download/[videoId] endpoint as the menu.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { BookmarkIcon, DownloadIcon } from '@/components/icons';
import { startDownload } from '@/components/downloadClient';
import { useSessionState } from '@/components/useSession';
import { VideoRenameDialog } from '@/components/VideoRenameDialog';
import { VideoDeleteDialog } from '@/components/VideoDeleteDialog';

export function VideoActions({
  videoId,
  megaFilename = '',
  title = '',
  canManage = false,
}: {
  videoId: number;
  /** Current MEGA filename (rename dialog initial value). */
  megaFilename?: string;
  /** Display title (delete confirmation). */
  title?: string;
  /** Owner-only Rename/Delete actions (API enforces ownership regardless). */
  canManage?: boolean;
}) {
  const router = useRouter();
  // Phase 3C: reuse the shell session instead of probing membership for
  // visitors who cannot have any (saves 2x401 round trips on every
  // signed-out video view; signed-in behavior unchanged).
  const { user } = useSessionState();
  const [watchlisted, setWatchlisted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Membership is loaded once on mount (same lazy pattern as the card menu).
  // Signed-out visitors have no membership: skip the probes entirely.
  useEffect(() => {
    // Signed-out visitors have no membership: skip the probes entirely
    // (user comes from the shared shell session, no extra fetch).
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const [w, s] = await Promise.all([
          fetch(`/api/watchlist/${videoId}`),
          fetch(`/api/saved/${videoId}`),
        ]);
        if (w.status === 401 || s.status === 401) {
          if (!cancelled) setDenied(true);
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
  }, [videoId, user]);

  async function toggle(kind: 'watchlist' | 'saved') {
    const active = kind === 'watchlist' ? watchlisted : saved;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/${kind}/${videoId}`, { method: active ? 'DELETE' : 'POST' });
      if (res.status === 401) {
        setDenied(true);
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

  // Signed-out visitors and 401s render nothing (same as before, but
  // without firing membership probes that can only 401).
  if (!user || denied) return null;

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
        {canManage && (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setRenameOpen(true)}
              ariaLabel="Rename video"
            >
              Rename
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => setDeleteOpen(true)}
              ariaLabel="Delete video"
            >
              Delete video
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
      {canManage && renameOpen && (
        <VideoRenameDialog
          videoId={videoId}
          currentFilename={megaFilename}
          open={renameOpen}
          onClose={() => setRenameOpen(false)}
          onRenamed={() => router.refresh()}
        />
      )}
      {canManage && deleteOpen && (
        <VideoDeleteDialog
          videoId={videoId}
          videoTitle={title || megaFilename.replace(/\.[^.]+$/, '') || 'This video'}
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onDeleted={() => router.push('/library')}
        />
      )}
    </div>
  );
}
