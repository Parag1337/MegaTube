'use client';

import { useState, useEffect } from 'react';

interface Creator {
  id: number;
  name: string;
  slug: string;
  avatar: string | null;
}

interface VideoCreatorControlProps {
  videoId: number;
  currentCreator: Creator | null;
  /**
   * Optional custom trigger (e.g. a dropdown menu item). When provided, the
   * default "Change creator" button is replaced and calling open() shows the
   * same assign dialog. Default behavior is unchanged.
   */
  trigger?: (open: () => void) => React.ReactNode;
}

export default function VideoCreatorControl({ videoId, currentCreator, trigger }: VideoCreatorControlProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [creators, setCreators] = useState<Creator[]>([]);
  const [selectedCreatorId, setSelectedCreatorId] = useState<number | null>(currentCreator?.id || null);
  const [newCreatorName, setNewCreatorName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'select' | 'create'>('select');

  useEffect(() => {
    if (isOpen) {
      const loadCreators = async () => {
        try {
          const response = await fetch('/api/creators');
          if (!response.ok) throw new Error('Failed to load creators');
          const data = await response.json();
          setCreators(data.creators || []);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to load creators');
        }
      };
      loadCreators().catch(console.error);
    }
  }, [isOpen]);

  const handleAssign = async () => {
    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/videos/${videoId}/creator`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: selectedCreatorId }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update creator');
      }

      setIsOpen(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateCreator = async () => {
    if (!newCreatorName.trim()) return;

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch('/api/creators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newCreatorName }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create creator');
      }

      const data = await response.json();
      const newCreator = data.creator;
      
      // Assign the new creator to the video
      const assignResponse = await fetch(`/api/videos/${videoId}/creator`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: newCreator.id }),
      });

      if (!assignResponse.ok) {
        throw new Error('Failed to assign creator');
      }

      setIsOpen(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  const handleRemoveCreator = async () => {
    if (!confirm('Remove creator assignment from this video?')) return;

    setIsLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/videos/${videoId}/creator`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: null }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to remove creator');
      }

      setIsOpen(false);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {trigger ? (
        trigger(() => setIsOpen(true))
      ) : (
        <button
          onClick={() => setIsOpen(true)}
          className="text-sm font-medium text-accent hover:underline"
        >
          {currentCreator ? 'Change creator' : 'Assign creator'}
        </button>
      )}

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={() => setIsOpen(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="assign-creator-title"
            className="w-full max-w-md rounded-3xl border border-border bg-surface-raised p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="assign-creator-title" className="text-lg font-bold tracking-tight">
              {currentCreator ? 'Change creator' : 'Assign creator'}
            </h2>

            {error && (
              <p role="alert" className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                {error}
              </p>
            )}

            {mode === 'select' ? (
              <>
                <div className="mb-4 mt-4 max-h-60 overflow-y-auto">
                  {creators.length === 0 ? (
                    <p className="text-sm text-muted">No creators yet. Create one first.</p>
                  ) : (
                    <ul className="space-y-2">
                      {creators.map((creator) => (
                        <li key={creator.id}>
                          <button
                            onClick={() => setSelectedCreatorId(creator.id)}
                            aria-pressed={selectedCreatorId === creator.id}
                            className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition-colors ${
                              selectedCreatorId === creator.id
                                ? 'border-accent bg-accent-soft'
                                : 'border-border hover:bg-surface-hover'
                            }`}
                          >
                            {creator.avatar ? (
                              <img
                                src={`/api/creators/${creator.id}/photo`}
                                alt=""
                                className="h-10 w-10 rounded-full object-cover"
                              />
                            ) : (
                              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-overlay text-sm font-bold text-accent">
                                {creator.name.charAt(0).toUpperCase()}
                              </span>
                            )}
                            <span className="truncate text-sm font-medium">{creator.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="mb-4">
                  <button
                    onClick={() => setMode('create')}
                    className="h-11 w-full rounded-2xl border border-dashed border-border-light text-sm font-medium text-muted transition-colors hover:border-accent hover:text-accent"
                  >
                    + Create new creator
                  </button>
                </div>

                <div className="flex items-center justify-between gap-2">
                  {currentCreator ? (
                    <button
                      onClick={handleRemoveCreator}
                      className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                      disabled={isLoading}
                    >
                      Remove
                    </button>
                  ) : (
                    <span />
                  )}
                  <div className="ml-auto flex gap-2">
                    <button
                      onClick={() => setIsOpen(false)}
                      className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAssign}
                      className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                      disabled={isLoading || creators.length === 0}
                    >
                      {isLoading ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mb-4 mt-4">
                  <label htmlFor="newCreatorName" className="mb-1.5 block text-[13px] font-medium">
                    Creator name
                  </label>
                  <input
                    id="newCreatorName"
                    type="text"
                    value={newCreatorName}
                    onChange={(e) => setNewCreatorName(e.target.value)}
                    className="h-11 w-full rounded-xl border border-border bg-surface-overlay px-4 text-sm focus:border-accent focus:outline-none"
                    placeholder="Enter creator name"
                    maxLength={200}
                  />
                </div>

                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => setMode('select')}
                    className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                    disabled={isLoading}
                  >
                    Back
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setIsOpen(false)}
                      className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateCreator}
                      className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                      disabled={isLoading || !newCreatorName.trim()}
                    >
                      {isLoading ? 'Creating…' : 'Create & assign'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
