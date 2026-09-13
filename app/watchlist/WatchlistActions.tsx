'use client';

/**
 * Bulk actions for the Watchlist page header.
 *
 * Play All opens every currently loaded watchlist video in its own new
 * browser tab (the normal video page - no playlist/queue system). All
 * window.open calls run synchronously inside the click handler so popup
 * blockers treat them as one user gesture. On paginated lists only the
 * current page's items open.
 *
 * Download All runs a bounded queue over the loaded items:
 *   1. HEAD-check each video (concurrency 3, cheap: no MEGA traffic) so
 *      failures are classified BEFORE spending a browser multi-download
 *      permission;
 *   2. re-check then dispatch one hidden-iframe download per available
 *      video, spaced out, so the browser handles each as a normal
 *      attachment and an error can never navigate the page away.
 * One failure never aborts the rest; failures are listed with a retry.
 * Browsers may ask permission for multiple automatic downloads - the panel
 * says so instead of working around it.
 *
 * Clear All is destructive: it always asks first via a confirmation dialog
 * (Cancel changes nothing), then deletes only the user's watchlist rows and
 * refreshes the grid without a full page reload. Saved Videos and History
 * are untouched.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { dispatchDownload } from '@/components/downloadClient';
import { runBounded } from '@/lib/download';

/** Bounded HEAD-check concurrency for the Download All queue. */
export const DOWNLOAD_ALL_CONCURRENCY = 3;

export interface WatchlistDownloadItem {
  id: number;
  slug: string;
  title: string;
}

type EntryStatus = 'pending' | 'checking' | 'ready' | 'failed' | 'started';

interface QueueEntry {
  item: WatchlistDownloadItem;
  status: EntryStatus;
  error: string | null;
}

function classifyHeadStatus(status: number): string {
  if (status === 401) return 'Signed out - sign in again and retry.';
  if (status === 404) return 'Not available for download.';
  if (status === 409) return 'Needs its MEGA account reconnected.';
  if (status === 410) return 'No longer available on MEGA.';
  if (status === 503) return 'Download service busy.';
  return `Failed (HTTP ${status}).`;
}

const DISPATCH_GAP_MS = 400;

export function WatchlistActions({ items }: { items: WatchlistDownloadItem[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [error, setError] = useState('');
  // Download queue state. entriesRef mirrors queue state so the async
  // runner can snapshot without waiting for a re-render.
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [current, setCurrent] = useState('');
  const entriesRef = useRef<QueueEntry[]>([]);
  const cancelRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const empty = items.length === 0 || cleared;
  const running = queue !== null && queue.some((e) => e.status === 'pending' || e.status === 'checking');
  const dispatching = queue !== null && !running && queue.some((e) => e.status === 'ready');

  function playAll() {
    for (const item of items) {
      window.open(`/video/${item.slug}`, '_blank', 'noopener');
    }
  }

  function setEntries(next: QueueEntry[] | null) {
    entriesRef.current = next ?? [];
    setQueue(next);
  }

  function setEntryStatus(id: number, status: EntryStatus, error: string | null = null) {
    setEntries(entriesRef.current.map((e) => (e.item.id === id ? { ...e, status, error } : e)));
  }

  async function runQueue(targets: WatchlistDownloadItem[]) {
    setEntries(targets.map((item) => ({ item, status: 'pending', error: null })));
    setCurrent('');
    cancelRef.current = false;
    const aborter = new AbortController();
    abortRef.current = aborter;

    // Phase 1: bounded availability checks (one failure never aborts rest).
    const result = await runBounded(targets, DOWNLOAD_ALL_CONCURRENCY, async (item) => {
      if (cancelRef.current) throw new Error('Cancelled.');
      setEntryStatus(item.id, 'checking');
      setCurrent(item.title);
      let res: Response;
      try {
        res = await fetch(`/api/download/${item.id}`, { method: 'HEAD', signal: aborter.signal });
      } catch (err) {
        if (cancelRef.current || aborter.signal.aborted) throw new Error('Cancelled.');
        throw new Error(err instanceof Error ? err.message : 'Request failed.');
      }
      if (!res.ok) throw new Error(classifyHeadStatus(res.status));
      setEntryStatus(item.id, 'ready');
    });
    for (const f of result.failed) {
      setEntries(
        entriesRef.current.map((e) =>
          e.item.id === f.item.id ? { ...e, status: 'failed' as const, error: f.error } : e,
        ),
      );
    }

    // Phase 2: dispatch one download per available video, spaced out. Each
    // item is HEAD re-checked just before dispatch (cheap, no MEGA traffic)
    // so a video that became unavailable during phase 1 is recorded as
    // failed instead of dispatched. Dispatch goes through a hidden iframe
    // (same helper as the menu/button): a residual race that still answers
    // an error lands invisibly in the frame and can never navigate the
    // watchlist page away to a JSON error.
    for (const entry of entriesRef.current) {
      if (cancelRef.current) break;
      if (entry.status !== 'ready') continue;
      setCurrent(entry.item.title);
      let fresh = true;
      try {
        const recheck = await fetch(`/api/download/${entry.item.id}`, {
          method: 'HEAD',
          signal: aborter.signal,
        });
        if (!recheck.ok) {
          setEntryStatus(entry.item.id, 'failed', classifyHeadStatus(recheck.status));
          fresh = false;
        }
      } catch {
        if (cancelRef.current || aborter.signal.aborted) break;
        setEntryStatus(entry.item.id, 'failed', 'Request failed.');
        fresh = false;
      }
      if (!fresh) continue;
      dispatchDownload(entry.item.id);
      setEntryStatus(entry.item.id, 'started');
      await new Promise((r) => setTimeout(r, DISPATCH_GAP_MS));
    }
    setCurrent('');
    abortRef.current = null;
  }

  function cancelQueue() {
    cancelRef.current = true;
    try {
      abortRef.current?.abort();
    } catch {
      // ignore
    }
    // Pending entries that never ran are marked failed-as-cancelled so the
    // panel settles instead of hanging.
    setEntries(
      entriesRef.current.map((e) =>
        e.status === 'pending' || e.status === 'checking'
          ? { ...e, status: 'failed' as const, error: 'Cancelled.' }
          : e,
      ),
    );
    setCurrent('');
  }

  function retryFailed() {
    if (!queue) return;
    const failed = queue.filter((e) => e.status === 'failed').map((e) => e.item);
    if (failed.length > 0) void runQueue(failed);
  }

  const checked = queue?.filter((e) => e.status !== 'pending' && e.status !== 'checking').length ?? 0;
  const total = queue?.length ?? 0;
  const started = queue?.filter((e) => e.status === 'started').length ?? 0;
  const failed = queue?.filter((e) => e.status === 'failed') ?? [];
  const done = queue !== null && !running && !dispatching;

  async function clearAll() {
    setClearing(true);
    setError('');
    try {
      const res = await fetch('/api/watchlist', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not clear the watchlist.');
      setCleared(true);
      setConfirming(false);
      setEntries(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" onClick={playAll} disabled={empty}>
        ▶ Play All
      </Button>
      <Button
        disabled={empty || running || dispatching}
        onClick={() => void runQueue(items)}
        ariaLabel="Download all watchlist videos"
      >
        {running || dispatching ? 'Downloading…' : 'Download All'}
      </Button>
      <Button variant="danger" onClick={() => { setError(''); setConfirming(true); }} disabled={empty}>
        Clear All
      </Button>

      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}

      {queue && (
        <div
          className="w-full rounded-2xl border border-border bg-surface p-4"
          role="status"
          aria-label="Download All progress"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">
              {done ? 'Download All finished' : `Downloading ${checked} / ${total}`}
            </p>
            {(running || dispatching) && (
              <button
                type="button"
                onClick={cancelQueue}
                className="inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-muted hover:bg-surface-hover hover:text-foreground"
              >
                Cancel
              </button>
            )}
          </div>
          {!done && current && (
            <p className="mt-1 truncate text-[13px] text-muted">
              Current: <span className="text-foreground">{current}</span>
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">
            <span>
              Completed: <span className="font-medium text-foreground">{started}</span>
            </span>
            <span>
              Failed: <span className="font-medium text-foreground">{failed.length}</span>
            </span>
            <span>
              Remaining: <span className="font-medium text-foreground">{total - checked}</span>
            </span>
          </div>
          {!done && (
            <p className="mt-2 text-xs leading-relaxed text-muted">
              If your browser asks for permission to download multiple files, allow it to continue the queue.
            </p>
          )}
          {done && failed.length > 0 && (
            <div className="mt-3 border-t border-border pt-3">
              <p className="text-[13px] font-medium text-foreground">
                {failed.length} failed:
              </p>
              <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
                {failed.map((e) => (
                  <li key={e.item.id} className="truncate text-[13px] text-muted">
                    {e.item.title}
                    {e.error && <span className="text-muted-light"> — {e.error}</span>}
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <Button size="sm" onClick={retryFailed}>
                  Retry failed ({failed.length})
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={() => { if (!clearing) setConfirming(false); }}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-watchlist-title"
            className="w-full max-w-md rounded-3xl border border-border bg-surface-raised p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="clear-watchlist-title" className="text-lg font-bold tracking-tight">
              Clear watchlist?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              Are you sure you want to remove all videos from your watchlist?
              Your Saved Videos and History will not be affected.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={clearing}
                className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={clearAll}
                disabled={clearing}
                className="inline-flex h-10 items-center rounded-full bg-destructive px-5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {clearing ? 'Clearing…' : 'Clear Watchlist'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
