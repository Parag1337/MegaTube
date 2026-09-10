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
}

export default function VideoCreatorControl({ videoId, currentCreator }: VideoCreatorControlProps) {
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
      <button
        onClick={() => setIsOpen(true)}
        className="text-sm text-accent hover:text-accent-hover"
      >
        {currentCreator ? 'Change creator' : 'Assign creator'}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-surface p-6">
            <h2 className="mb-4 text-lg font-semibold">
              {currentCreator ? 'Change Creator' : 'Assign Creator'}
            </h2>

            {error && (
              <div className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {mode === 'select' ? (
              <>
                <div className="mb-4 max-h-60 overflow-y-auto">
                  {creators.length === 0 ? (
                    <p className="text-sm text-muted">No creators yet. Create one first.</p>
                  ) : (
                    <div className="space-y-2">
                      {creators.map((creator) => (
                        <button
                          key={creator.id}
                          onClick={() => setSelectedCreatorId(creator.id)}
                          className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                            selectedCreatorId === creator.id
                              ? 'border-accent bg-accent/10'
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
                            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-hover text-sm font-bold text-accent">
                              {creator.name.charAt(0).toUpperCase()}
                            </span>
                          )}
                          <span className="font-medium">{creator.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mb-4">
                  <button
                    onClick={() => setMode('create')}
                    className="w-full rounded-lg border border-dashed border-border py-2 text-sm text-muted transition-colors hover:border-accent hover:text-accent"
                  >
                    + Create new creator
                  </button>
                </div>

                <div className="flex justify-between">
                  {currentCreator && (
                    <button
                      onClick={handleRemoveCreator}
                      className="rounded-lg border border-destructive/50 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                      disabled={isLoading}
                    >
                      Remove
                    </button>
                  )}
                  <div className="flex gap-3 ml-auto">
                    <button
                      onClick={() => setIsOpen(false)}
                      className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAssign}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                      disabled={isLoading || creators.length === 0}
                    >
                      {isLoading ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mb-4">
                  <label htmlFor="newCreatorName" className="mb-2 block text-sm font-medium">
                    Creator Name *
                  </label>
                  <input
                    id="newCreatorName"
                    type="text"
                    value={newCreatorName}
                    onChange={(e) => setNewCreatorName(e.target.value)}
                    className="w-full rounded-lg border border-border bg-surface-hover px-3 py-2 text-sm focus:border-accent focus:outline-none"
                    placeholder="Enter creator name"
                    maxLength={200}
                  />
                </div>

                <div className="flex justify-between">
                  <button
                    onClick={() => setMode('select')}
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
                    disabled={isLoading}
                  >
                    Back
                  </button>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setIsOpen(false)}
                      className="rounded-lg border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-surface-hover"
                      disabled={isLoading}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleCreateCreator}
                      className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                      disabled={isLoading || !newCreatorName.trim()}
                    >
                      {isLoading ? 'Creating...' : 'Create & Assign'}
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
