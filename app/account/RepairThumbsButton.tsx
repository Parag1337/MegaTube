'use client';

/**
 * Owner-scoped thumbnail repair trigger. One bounded repair run at a time
 * (the API answers 429 while a run is in flight); results render inline.
 * Repairs only replace missing/black/broken thumbnails - good ones are
 * skipped server-side, so this is safe to run repeatedly.
 */

import { useState } from 'react';

interface RepairCounts {
  scanned: number;
  repaired: number;
  skippedGood: number;
  failed: number;
}

export function RepairThumbsButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RepairCounts | null>(null);
  const [error, setError] = useState('');

  async function run() {
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/thumbs/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => null);
      if (res.status === 429) throw new Error('A repair is already running - try again in a bit.');
      if (!res.ok) throw new Error((data as { error?: string } | null)?.error || 'Repair failed.');
      const summary = data as RepairCounts;
      setResult({
        scanned: summary.scanned ?? 0,
        repaired: summary.repaired ?? 0,
        skippedGood: summary.skippedGood ?? 0,
        failed: summary.failed ?? 0,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-overlay disabled:opacity-50"
        >
          {running ? 'Repairing…' : 'Repair thumbnails'}
        </button>
        {result && (
          <p className="text-[13px] text-muted" role="status">
            Scanned {result.scanned}: repaired {result.repaired}, already good {result.skippedGood
            }{result.failed > 0 ? `, failed ${result.failed}` : ''}.
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
