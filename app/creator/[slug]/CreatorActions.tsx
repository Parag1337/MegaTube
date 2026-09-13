'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface CreatorActionsProps {
  creatorId: number;
  creatorName: string;
}

export default function CreatorActions({ creatorId, creatorName }: CreatorActionsProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [name, setName] = useState(creatorName);
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch(`/api/creators/${creatorId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || undefined }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update creator');
      }

      setIsEditing(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Are you sure you want to delete "${creatorName}"? This will remove the creator but keep all videos.`)) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch(`/api/creators/${creatorId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to delete creator');
      }

      router.push('/creators');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setIsLoading(false);
    }
  };

  return (
    <>
      <div className="flex gap-2">
        <button
          onClick={() => setIsEditing(true)}
          className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium transition-colors hover:bg-surface-overlay"
        >
          Edit
        </button>
        <button
          onClick={() => setIsDeleting(true)}
          className="inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
        >
          Delete
        </button>
      </div>

      {isEditing && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={() => setIsEditing(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-creator-title"
            className="w-full max-w-md rounded-3xl border border-border bg-surface-raised p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="edit-creator-title" className="text-lg font-bold tracking-tight">Edit creator</h2>

            {error && (
              <p role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                {error}
              </p>
            )}

            <form onSubmit={handleEdit} className="mt-4 space-y-4">
              <div>
                <label htmlFor="name" className="mb-1.5 block text-[13px] font-medium">
                  Name
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-11 w-full rounded-xl border border-border bg-surface-overlay px-4 text-sm focus:border-accent focus:outline-none"
                  required
                  maxLength={200}
                />
              </div>

              <div>
                <label htmlFor="description" className="mb-1.5 block text-[13px] font-medium">
                  Description
                </label>
                <textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="h-auto min-h-[88px] w-full rounded-xl border border-border bg-surface-overlay px-4 py-3 text-sm focus:border-accent focus:outline-none"
                  rows={3}
                  maxLength={1000}
                />
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                  disabled={isLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                  disabled={isLoading || !name.trim()}
                >
                  {isLoading ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isDeleting && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={() => setIsDeleting(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-creator-title"
            className="w-full max-w-md rounded-3xl border border-border bg-surface-raised p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="delete-creator-title" className="text-lg font-bold tracking-tight">Delete creator</h2>

            {error && (
              <p role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                {error}
              </p>
            )}

            <p className="mt-3 text-sm leading-relaxed text-muted">
              Delete &ldquo;{creatorName}&rdquo;? All videos stay in your library and become unassigned.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setIsDeleting(false)}
                className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                disabled={isLoading}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="inline-flex h-10 items-center rounded-full bg-destructive px-5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={isLoading}
              >
                {isLoading ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
