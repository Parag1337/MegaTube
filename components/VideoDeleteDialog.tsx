'use client';

/**
 * Delete confirmation dialog: nothing destructive happens before the user
 * presses Delete. Same overlay/dialog styling as the other video dialogs;
 * the confirm button uses the destructive treatment.
 */

import { useEffect, useState } from 'react';

interface VideoDeleteDialogProps {
  videoId: number;
  videoTitle: string;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

export function VideoDeleteDialog({
  videoId,
  videoTitle,
  open,
  onClose,
  onDeleted,
}: VideoDeleteDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [prevOpen, setPrevOpen] = useState(open);

  // Fresh state on every open (render-time adjustment, no effect cascade).
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setError('');
      setDeleting(false);
    }
  }

  // Escape closes without changing anything.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function confirmDelete() {
    if (deleting) return;
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(`/api/videos/${videoId}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        throw new Error(data?.error || 'Could not delete the video.');
      }
      onDeleted();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the video.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={() => {
        if (!deleting) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-video-title"
        aria-describedby="delete-video-desc"
        className="w-full max-w-md rounded-3xl border border-destructive/40 bg-surface-raised p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="delete-video-title" className="text-lg font-bold tracking-tight text-destructive">
          Delete video?
        </h2>
        <p id="delete-video-desc" className="mt-2 text-sm leading-relaxed text-muted">
          <span className="font-medium text-foreground">{videoTitle}</span> will be permanently
          deleted from MEGA and removed from your library. This cannot be undone.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            autoFocus
            className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void confirmDelete()}
            disabled={deleting}
            className="inline-flex h-10 items-center rounded-full bg-destructive px-5 text-sm font-medium text-white transition-colors hover:brightness-110 disabled:opacity-50"
          >
            {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
