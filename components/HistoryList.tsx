'use client';

/**
 * History in LIST layout (not the normal video grid): compact thumbnail
 * rows, newest watched first, each with a remove button, plus a Clear
 * History action. Local state updates immediately; page changes go through
 * the server-rendered pagination links.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pagination } from '@/components/Pagination';
import { EmptyState } from '@/components/ui';
import { CreatorsIcon, HistoryIcon, TrashIcon } from '@/components/icons';

export interface HistoryListItem {
  id: number;
  slug: string;
  title: string;
  megaFilename: string;
  thumbnail: string | null;
  duration?: number | null;
  creator: { slug: string; name: string } | null;
  lastWatchedAt: Date | string;
}

function watchedLabel(raw: Date | string): string {
  const when = raw instanceof Date ? raw : new Date(raw);
  const mins = Math.max(0, Math.floor((Date.now() - when.getTime()) / 60000));
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return when.toLocaleDateString();
}

export function HistoryList({
  initialItems,
  page,
  totalPages,
  initialTotal,
  basePath,
}: {
  initialItems: HistoryListItem[];
  page: number;
  totalPages: number;
  initialTotal: number;
  basePath: string;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [total, setTotal] = useState(initialTotal);
  const [removing, setRemoving] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');

  async function removeOne(videoId: number) {
    setRemoving(videoId);
    setError('');
    try {
      const res = await fetch(`/api/history/${videoId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not remove that entry.');
      setItems((prev) => prev.filter((v) => v.id !== videoId));
      setTotal((t) => Math.max(0, t - 1));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRemoving(null);
    }
  }

  async function clearAll() {
    if (!confirm('Clear your entire watch history?')) return;
    setClearing(true);
    setError('');
    try {
      const res = await fetch('/api/history', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not clear history.');
      setItems([]);
      setTotal(0);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setClearing(false);
    }
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">History</h1>
          <p className="mt-1 text-[13px] text-muted">
            {total} watched video{total === 1 ? '' : 's'} · newest first
          </p>
        </div>
        {items.length > 0 && (
          <button
            type="button"
            onClick={clearAll}
            disabled={clearing}
            className="inline-flex h-9 items-center gap-2 rounded-full bg-surface-raised px-4 text-sm font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
          >
            <TrashIcon className="h-4 w-4" />
            {clearing ? 'Clearing…' : 'Clear history'}
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon className="h-7 w-7" />}
          title="No watch history yet"
          body="Videos you watch will show up here as a list, newest first."
          action={
            <Link
              href="/library"
              className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Browse Library
            </Link>
          }
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {items.map((video) => (
              <li
                key={video.id}
                className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-2.5 transition-colors hover:bg-surface-hover sm:gap-4 sm:p-3"
              >
                <Link
                  href={`/video/${video.slug}`}
                  className="relative aspect-video w-36 shrink-0 overflow-hidden rounded-xl bg-surface-raised sm:w-44"
                  aria-label={video.title}
                >
                  {video.thumbnail ? (
                    <img
                      src={video.thumbnail}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-muted-light">
                      <CreatorsIcon className="h-6 w-6" />
                    </span>
                  )}
                </Link>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/video/${video.slug}`}
                    className="line-clamp-2 text-sm font-medium leading-snug hover:text-accent sm:text-[15px]"
                  >
                    {video.title || video.megaFilename.replace(/\.[^.]+$/, '')}
                  </Link>
                  <p className="mt-1 truncate text-xs text-muted sm:text-[13px]">
                    {video.creator ? video.creator.name : 'Unknown Creator'}
                    {' · '}
                    Watched {watchedLabel(video.lastWatchedAt)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeOne(video.id)}
                  disabled={removing === video.id}
                  aria-label={`Remove ${video.title} from history`}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                >
                  <TrashIcon className="h-[18px] w-[18px]" />
                </button>
              </li>
            ))}
          </ul>
          <Pagination page={page} totalPages={totalPages} basePath={basePath} />
        </>
      )}
    </div>
  );
}
