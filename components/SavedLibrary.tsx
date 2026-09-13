'use client';

/**
 * Saved Videos with simple user-created folders.
 *
 * Data always comes from the server (props); every mutation (create,
 * rename, delete, move, unsave) hits the API and then refreshes/navigates
 * so the UI updates without a full page reload and never goes stale.
 * Local state is only form UI (inputs, pending flags, errors).
 *
 * Folders are application-level only: created explicitly by the user, never
 * inferred from MEGA structure, filenames, or creators.
 */

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pagination } from '@/components/Pagination';
import { ThumbImage } from '@/components/ThumbImage';
import { EmptyState } from '@/components/ui';
import { BookmarkIcon, CreatorsIcon } from '@/components/icons';

export interface SavedFolderItem {
  id: number;
  name: string;
  videoCount: number;
}

export interface SavedLibraryVideo {
  id: number;
  slug: string;
  title: string;
  megaFilename: string;
  thumbnail: string | null;
  creator: { slug: string; name: string } | null;
  folderId: number | null;
}

const chipCls = (active: boolean) =>
  `inline-flex h-9 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors ${
    active
      ? 'bg-foreground text-background'
      : 'bg-surface-raised text-muted hover:bg-surface-overlay hover:text-foreground'
  }`;

export function SavedLibrary({
  folders,
  videos,
  total,
  totalAll,
  page,
  totalPages,
  basePath,
  currentFolder,
  currentFolderName,
}: {
  folders: SavedFolderItem[];
  videos: SavedLibraryVideo[];
  total: number;
  totalAll: number;
  page: number;
  totalPages: number;
  basePath: string;
  currentFolder: number | 'all' | 'none';
  currentFolderName: string | null;
}) {
  const router = useRouter();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState(currentFolderName ?? '');
  const [busy, setBusy] = useState(false);
  const [movingId, setMovingId] = useState<number | null>(null);
  const [error, setError] = useState('');

  const inFolderView = typeof currentFolder === 'number';

  async function refresh() {
    router.refresh();
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/saved/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data as { error?: string } | null)?.error || 'Could not create folder.');
      setNewName('');
      setShowCreate(false);
      const id = (data as { folder?: { id?: number } } | null)?.folder?.id;
      if (typeof id === 'number') router.push(`/account/saved?folder=${id}`);
      else refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function renameFolder(e: React.FormEvent) {
    e.preventDefault();
    if (typeof currentFolder !== 'number' || busy) return;
    const name = renameName.trim();
    if (!name) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/saved/folders/${currentFolder}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data as { error?: string } | null)?.error || 'Could not rename folder.');
      setRenaming(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteFolder() {
    if (typeof currentFolder !== 'number' || busy) return;
    if (!confirm(`Delete folder "${currentFolderName}"? Its videos stay saved and return to All Saved.`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/saved/folders/${currentFolder}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not delete folder.');
      router.push('/account/saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  async function moveVideo(videoId: number, folderId: number | null) {
    setMovingId(videoId);
    setError('');
    try {
      const res = await fetch(`/api/saved/${videoId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) throw new Error('Could not move video.');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setMovingId(null);
    }
  }

  async function unsaveVideo(videoId: number) {
    setMovingId(videoId);
    setError('');
    try {
      const res = await fetch(`/api/saved/${videoId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not unsave video.');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setMovingId(null);
    }
  }

  return (
    <div>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Saved Videos</h1>
        <p className="mt-1 text-[13px] text-muted">
          {inFolderView && currentFolderName
            ? `${total} video${total === 1 ? '' : 's'} in “${currentFolderName}” · ${totalAll} saved in total`
            : `${totalAll} bookmarked video${totalAll === 1 ? '' : 's'}`}
        </p>
      </div>

      {/* ------------------------------------------------ Folder nav ------ */}
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="navigation" aria-label="Saved folders">
        <Link href="/account/saved" aria-current={currentFolder === 'all' ? 'true' : undefined} className={chipCls(currentFolder === 'all')}>
          All Saved ({totalAll})
        </Link>
        {folders.map((f) => (
          <Link
            key={f.id}
            href={`/account/saved?folder=${f.id}`}
            aria-current={currentFolder === f.id ? 'true' : undefined}
            className={chipCls(currentFolder === f.id)}
          >
            {f.name} ({f.videoCount})
          </Link>
        ))}
        <button
          type="button"
          onClick={() => { setShowCreate((v) => !v); setError(''); }}
          className="inline-flex h-9 shrink-0 items-center rounded-xl border border-dashed border-border-light px-4 text-sm font-medium text-muted transition-colors hover:border-accent hover:text-accent"
        >
          + New folder
        </button>
      </div>

      {showCreate && (
        <form onSubmit={createFolder} className="mb-4 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Folder name"
            maxLength={100}
            aria-label="New folder name"
            autoFocus
            className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface px-4 text-sm focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !newName.trim()}
            className="inline-flex h-10 shrink-0 items-center rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
      )}

      {/* --------------------------------------------- Folder toolbar ----- */}
      {inFolderView && currentFolderName && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface p-3">
          {renaming ? (
            <form onSubmit={renameFolder} className="flex min-w-0 flex-1 gap-2">
              <input
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                maxLength={100}
                aria-label="Folder name"
                autoFocus
                className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-surface-overlay px-4 text-sm focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !renameName.trim()}
                className="inline-flex h-10 shrink-0 items-center rounded-full bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => { setRenaming(false); setRenameName(currentFolderName); }}
                className="inline-flex h-10 shrink-0 items-center rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-hover hover:text-foreground"
              >
                Cancel
              </button>
            </form>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold">{currentFolderName}</span>
              <button
                type="button"
                onClick={() => { setRenaming(true); setRenameName(currentFolderName); setError(''); }}
                className="inline-flex h-9 shrink-0 items-center rounded-full bg-surface-raised px-4 text-sm font-medium hover:bg-surface-overlay"
              >
                Rename
              </button>
              <button
                type="button"
                onClick={deleteFolder}
                disabled={busy}
                className="inline-flex h-9 shrink-0 items-center rounded-full px-4 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                Delete folder
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* -------------------------------------------------- Video list ---- */}
      {videos.length === 0 ? (
        <EmptyState
          icon={<BookmarkIcon className="h-7 w-7" />}
          title={inFolderView ? 'This folder is empty' : 'No saved videos yet'}
          body={
            inFolderView
              ? 'Move saved videos here with the folder picker on each video.'
              : 'Open any video’s three-dot menu and choose “Save video” to bookmark it here.'
          }
          action={
            !inFolderView ? (
              <Link
                href="/library"
                className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover"
              >
                Browse Library
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {videos.map((video) => (
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
                    <ThumbImage src={video.thumbnail} />
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
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <label className="sr-only" htmlFor={`folder-${video.id}`}>
                      Folder for {video.title}
                    </label>
                    <select
                      id={`folder-${video.id}`}
                      value={video.folderId === null ? '' : String(video.folderId)}
                      disabled={movingId === video.id}
                      onChange={(e) =>
                        moveVideo(video.id, e.target.value === '' ? null : Number(e.target.value))
                      }
                      className="h-8 max-w-full rounded-lg border border-border bg-surface-raised px-2 text-[13px] text-foreground focus:border-accent focus:outline-none disabled:opacity-50"
                    >
                      <option value="">All Saved (no folder)</option>
                      {folders.map((f) => (
                        <option key={f.id} value={String(f.id)}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => unsaveVideo(video.id)}
                      disabled={movingId === video.id}
                      className="inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium text-muted hover:bg-surface-overlay hover:text-foreground disabled:opacity-50"
                    >
                      Unsave
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={page} totalPages={totalPages} basePath={basePath} />
        </>
      )}
    </div>
  );
}
