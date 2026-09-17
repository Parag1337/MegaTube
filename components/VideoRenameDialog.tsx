'use client';

/**
 * Rename dialog: edits the actual MEGA filename, then refreshes MegaTube's
 * metadata from it. Same overlay/dialog styling as the creator controls.
 *
 * Contract with the server (POST /api/videos/[videoId]/rename { name }):
 * the MEGA node is renamed first and the DB only after - the dialog just
 * surfaces the result (or a clean error) and reports the updated video.
 */

import { useEffect, useRef, useState } from 'react';

export interface RenamedVideoInfo {
  id: number;
  title: string;
  megaFilename: string;
  slug: string;
  creator: { slug: string; name: string } | null;
}

interface VideoRenameDialogProps {
  videoId: number;
  currentFilename: string;
  open: boolean;
  onClose: () => void;
  onRenamed: (video: RenamedVideoInfo) => void;
}

export function VideoRenameDialog({
  videoId,
  currentFilename,
  open,
  onClose,
  onRenamed,
}: VideoRenameDialogProps) {
  const [name, setName] = useState(currentFilename);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [prevOpen, setPrevOpen] = useState(open);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset + focus every time the dialog opens (render-time adjustment so
  // opening never carries stale state; no cascading effect renders).
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setName(currentFilename);
      setError('');
      setSaving(false);
    }
  }
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.select(), 0);
    return () => clearTimeout(t);
  }, [open ]);

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

  const trimmed = name.trim();
  const unchanged = trimmed === currentFilename.trim();
  const canConfirm = !saving && trimmed.length > 0 && !unchanged;

  async function submit() {
    if (!canConfirm) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/videos/${videoId}/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = (await res.json().catch(() => null)) as {
        video?: RenamedVideoInfo;
        error?: string;
      } | null;
      if (!res.ok) {
        throw new Error(data?.error || 'Could not rename the video.');
      }
      if (!data?.video) throw new Error('Could not rename the video.');
      onRenamed(data.video);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the video.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
      onClick={() => {
        if (!saving) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-video-title"
        className="w-full max-w-md rounded-3xl border border-border bg-surface-raised p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="rename-video-title" className="text-lg font-bold tracking-tight">
          Rename video
        </h2>
        <p className="mt-1 text-[13px] text-muted">
          Renames the file on MEGA. Use “Creator - Title” to assign a creator.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          >
            {error}
          </p>
        )}

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="rename-video-input" className="mb-1.5 block text-[13px] font-medium">
            Filename
          </label>
          <input
            ref={inputRef}
            id="rename-video-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
            className="h-11 w-full rounded-xl border border-border bg-surface-overlay px-4 text-sm focus:border-accent focus:outline-none"
          />
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canConfirm}
              className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
