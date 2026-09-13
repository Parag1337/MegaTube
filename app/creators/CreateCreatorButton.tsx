'use client';

import { useEffect, useRef, useState } from 'react';
import { Field, inputClassName, Button } from '@/components/ui';
import { PlusIcon, AlertIcon } from '@/components/icons';

export default function CreateCreatorButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      nameRef.current?.focus();
      function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape') setIsOpen(false);
      }
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }
  }, [isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/creators', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: description || undefined }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create creator');
      }

      setName('');
      setDescription('');
      setIsOpen(false);
      window.location.reload(); // Simple refresh to show new creator
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setIsOpen(true)} className="h-9 px-4">
        <PlusIcon className="h-4 w-4" />
        New creator
      </Button>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={() => setIsOpen(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-creator-title"
            className="w-full max-w-md rounded-3xl border border-border bg-surface-raised p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="create-creator-title" className="text-lg font-bold tracking-tight">
              New creator
            </h2>

            {error && (
              <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </p>
            )}

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              <Field label="Name" htmlFor="creator-name">
                <input
                  ref={nameRef}
                  id="creator-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className={`${inputClassName} bg-surface-overlay`}
                  placeholder="Creator name"
                  required
                  maxLength={200}
                />
              </Field>

              <Field label="Description" htmlFor="creator-description" hint="Optional.">
                <textarea
                  id="creator-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={`${inputClassName} h-auto min-h-[88px] bg-surface-overlay py-3`}
                  placeholder="Optional description"
                  rows={3}
                  maxLength={1000}
                />
              </Field>

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => setIsOpen(false)} disabled={isLoading}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={isLoading || !name.trim()}>
                  {isLoading ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
