'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface PreviewStats {
  totalVideos: number;
  completedPreviews: number;
  missingPreviews: number;
  pending: number;
  queued: number;
  generating: number;
  failed: number;
  unsupported: number;
  completedJobs: number;
  previewBytes: number;
  cacheBytes: number;
  cacheMaxBytes: number;
  oldestPendingAgeMs: number | null;
  currentGenerationVersion: string;
  autoGenerate: boolean;
  paused: boolean;
  current: {
    jobId: number;
    videoId: number;
    title: string;
    stage: string | null;
    startedAt: string | null;
  } | null;
}

interface FailureItem {
  jobId: number;
  videoId: number;
  status: string;
  errorCode: string | null;
  lastError: string | null;
  attempts: number;
}

const POLL_MS = 5000;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function formatAge(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Phase 5.1: "Video Preview Management" settings section.
 *
 * Every number comes from the server's live library/disk scan. Actions only
 * enqueue durable jobs; the single bounded worker does the actual work, so
 * pressing these buttons can never start hundreds of ffmpeg processes.
 */
export function PreviewManagement({ hideHeader = false }: { hideHeader?: boolean } = {}) {
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [failures, setFailures] = useState<FailureItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteStarted, setDeleteStarted] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const heading = (
    <h2 id="preview-heading" className={hideHeader ? 'sr-only' : 'text-[15px] font-semibold'}>
      Fix Previews
    </h2>
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/preview/admin/stats', { cache: 'no-store' });
      if (!res.ok) {
        if (mountedRef.current) setError('Preview statistics are unavailable.');
        return;
      }
      const data = (await res.json()) as { stats: PreviewStats; failures: FailureItem[] };
      if (!mountedRef.current) return;
      setStats(data.stats);
      setFailures(data.failures ?? []);
      setError(null);
    } catch {
      if (mountedRef.current) setError('Preview statistics are unavailable.');
    }
  }, []);

  const deleteAllPreviews = useCallback(async () => {
    setDeleteStarted(true);
    setDeleteProgress('Deleting previews…');
    try {
      const res = await fetch('/api/preview/admin/delete-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setDeleteStarted(false);
        setDeleteProgress(null);
        setNotice(typeof data.error === 'string' ? data.error : 'Failed to delete previews.');
        return false;
      }
      // The route finishes the deletion before responding, so this result is
      // the complete, accurate outcome rather than an optimistic estimate.
      const result = data.result as Record<string, unknown> | undefined;
      const filesDeleted = (result?.filesDeleted as number) ?? 0;
      const bytesFreed = (result?.bytesFreed as number) ?? 0;
      const jobsDeleted = (result?.jobsDeleted as number) ?? 0;
      const skippedActiveVideos = (result?.skippedActiveVideos as number) ?? 0;
      setNotice(
        `Deleted ${filesDeleted} preview artifact(s) (${formatBytes(bytesFreed)}), ` +
          `removed ${jobsDeleted} queue record(s).` +
          (skippedActiveVideos > 0
            ? ` Skipped ${skippedActiveVideos} video(s) that are currently generating or being viewed.`
            : '') +
          ' Previews will regenerate on next sync or when you press Generate.',
      );
      setDeleteProgress(null);
      setDeleteStarted(false);
      setDeleteDialogOpen(false);
      setDeleteConfirm(false);
      await load();
      return true;
    } catch {
      setDeleteStarted(false);
      setDeleteProgress(null);
      setNotice('Action failed.');
      return false;
    }
  }, [load]);

  const action = useCallback(
    async (name: string, run: () => Promise<Response>) => {
      setBusy(name);
      setNotice(null);
      try {
        const res = await run();
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          setNotice(typeof data.error === 'string' ? data.error : 'Action failed.');
          return false;
        }
        if (name === 'generate') {
          const r = (data.result ?? {}) as Record<string, number>;
          setNotice(
            `Queued ${r.enqueued ?? 0} job(s). ${r.skippedComplete ?? 0} preview(s) already complete, ` +
              `${r.alreadyQueued ?? 0} already in the queue.`,
          );
        } else if (name === 'retry') {
          const r = (data.result ?? {}) as Record<string, number>;
          setNotice(`Re-queued ${r.retried ?? 0} job(s).`);
        } else {
          setNotice('Saved.');
        }
        await load();
        return true;
      } catch {
        setNotice('Action failed.');
        return false;
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [load],
  );

  const toggleAutoGenerate = useCallback(
    (next: boolean) => {
      void (async () => {
        const ok = await action('settings', () =>
          fetch('/api/preview/admin/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoGenerate: next }),
          }),
        );
        // The stats endpoint is intentionally cached for a few seconds, so
        // its response may still hold the pre-toggle preference. Reflect the
        // successful PATCH immediately instead of letting that stale value
        // snap the checkbox back.
        if (ok && mountedRef.current) {
          setStats((prev) => (prev ? { ...prev, autoGenerate: next } : prev));
        }
      })();
    },
    [action],
  );

  const togglePaused = useCallback(
    (next: boolean) => {
      void (async () => {
        const ok = await action('settings', () =>
          fetch('/api/preview/admin/settings', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paused: next }),
          }),
        );
        if (ok && mountedRef.current) {
          setStats((prev) => (prev ? { ...prev, paused: next } : prev));
        }
      })();
    },
    [action],
  );

  useEffect(() => {
    mountedRef.current = true;
    // Deferred a tick so the first fetch never synchronously setState during
    // the effect body (React 19 lint rule), then refresh on an interval.
    const initial = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      mountedRef.current = false;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [load]);

  if (error) {
    return (
      <section id="fix-previews" aria-labelledby="preview-heading" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
        {heading}
        <p className="mt-1 text-[13px] text-muted">{error}</p>
      </section>
    );
  }

  if (!stats) {
    return (
      <section id="fix-previews" aria-labelledby="preview-heading" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
        {heading}
        <p className="mt-1 text-[13px] text-muted">Loading preview statistics…</p>
      </section>
    );
  }

  const progress =
    stats.totalVideos > 0 ? Math.min(100, (stats.completedPreviews / stats.totalVideos) * 100) : 0;

  return (
    <section id="fix-previews" aria-labelledby="preview-heading" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
      {heading}
      {!hideHeader && (
        <p className="mt-1 text-[13px] text-muted">
          Find missing, invalid, or outdated previews and generate them in the
          background, one at a time, even after you leave Settings.
        </p>
      )}

      <div className="mt-4">
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="font-medium text-foreground">
            {stats.completedPreviews} of {stats.totalVideos} previews ready
          </span>
          <span className="tabular-nums text-muted">{progress.toFixed(0)}%</span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={stats.totalVideos}
          aria-valuenow={stats.completedPreviews}
          aria-label="Preview generation progress"
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-raised"
        >
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px] sm:grid-cols-3">
        <Stat label="Completed" value={stats.completedPreviews} />
        <Stat label="Missing" value={stats.missingPreviews} />
        <Stat label="Pending" value={stats.pending} />
        <Stat label="Queued" value={stats.queued} />
        <Stat label="Generating" value={stats.generating} />
        <Stat label="Failed" value={stats.failed} />
        <Stat label="Unsupported" value={stats.unsupported} />
        <Stat label="Preview storage" value={formatBytes(stats.previewBytes)} />
        <Stat label="Cache usage" value={`${formatBytes(stats.cacheBytes)} / ${formatBytes(stats.cacheMaxBytes)}`} />
      </dl>

      <p className="mt-3 text-[12px] text-muted">
        Oldest queued job: {formatAge(stats.oldestPendingAgeMs)}.
        {stats.current
          ? ` Currently generating: ${stats.current.title}${stats.current.stage ? ` (${stats.current.stage})` : ''}.`
          : ' Nothing is generating right now.'}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void action('generate', () => fetch('/api/preview/admin/generate', { method: 'POST' }))}
          className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
        >
          {busy === 'generate' ? 'Queueing…' : 'Generate Missing Previews'}
        </button>
        <button
          type="button"
          disabled={busy !== null || stats.failed === 0}
          onClick={() => void action('retry', () => fetch('/api/preview/admin/retry', { method: 'POST', body: '{}' }))}
          className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay disabled:opacity-50"
        >
          Retry failed
        </button>
        <button
          type="button"
          disabled={busy !== null || (stats.failed === 0 && stats.unsupported === 0)}
          onClick={() =>
            void action('retry', () =>
              fetch('/api/preview/admin/retry', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ includeUnsupported: true }),
              }),
            )
          }
          className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay disabled:opacity-50"
        >
          Retry unsupported
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => togglePaused(!stats.paused)}
          className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay disabled:opacity-50"
        >
          {stats.paused ? 'Resume generation' : 'Pause generation'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => { setDeleteDialogOpen(true); setDeleteConfirm(false); setDeleteStarted(false); setDeleteProgress(null); }}
          className="inline-flex h-9 items-center rounded-full bg-red-600 px-4 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
        >
          Delete All Previews
        </button>
      </div>

      <label className="mt-4 flex items-start gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={stats.autoGenerate}
          disabled={busy !== null}
          onChange={(e) => toggleAutoGenerate(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
        />
        <span>
          <span className="font-medium text-foreground">Automatically generate previews during video sync</span>
          <span className="block text-muted">
            When disabled, sync still works normally and the manual action above stays available.
          </span>
        </span>
      </label>

      {notice && (
        <p role="status" className="mt-3 rounded-lg bg-surface-raised px-3 py-2 text-[12px] text-foreground">
          {notice}
        </p>
      )}

      {failures.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] font-medium text-foreground">
            Failed and unsupported previews ({failures.length})
          </summary>
          <ul className="mt-2 space-y-1 text-[12px] text-muted">
            {failures.map((f) => (
              <li key={f.jobId} className="flex flex-wrap gap-x-2">
                <span className="font-medium text-foreground">#{f.videoId}</span>
                <span>{f.status}</span>
                <span>{f.errorCode ?? 'unknown'}</span>
                <span className="truncate">{f.lastError ?? 'No reason recorded.'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Delete All Previews Confirmation Dialog */}
      {deleteDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title">
          <div className="bg-surface rounded-2xl p-6 w-full max-w-md mx-4">
            <h3 id="delete-dialog-title" className="text-lg font-semibold text-foreground mb-4">
              Delete All Previews?
            </h3>
            {!deleteStarted ? (
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  This will permanently delete all generated preview clips, timeline spritesheets,
                  timeline VTT assets, and preview sidecar metadata for your entire video library.
                </p>
                <ul className="space-y-2 text-sm text-muted">
                  <li>✓ Preview clips (MP4) will be deleted</li>
                  <li>✓ Timeline spritesheets (JPG) will be deleted</li>
                  <li>✓ Timeline VTT assets will be deleted</li>
                  <li>✓ Preview sidecar metadata (JSON) will be deleted</li>
                  <li>✗ Original MEGA videos will NOT be deleted</li>
                  <li>✗ Video library records will NOT be deleted</li>
                  <li>✗ Linked MEGA accounts will NOT be affected</li>
                </ul>
                <p className="text-sm text-muted">
                  Preview generation will need to run again to recreate them. This can be done
                  manually via <strong>Generate Missing Previews</strong> or automatically on the
                  next video sync (if auto-generate is enabled).
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="delete-confirm-checkbox"
                    onChange={(e) => setDeleteConfirm(e.target.checked)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <label htmlFor="delete-confirm-checkbox" className="text-sm text-muted cursor-pointer">
                    I understand this action cannot be undone
                  </label>
                </div>
                <div className="mt-6 flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setDeleteDialogOpen(false); setDeleteConfirm(false); setDeleteStarted(false); setDeleteProgress(null); }}
                    className="flex-1 h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!deleteConfirm || deleteStarted}
                    onClick={() => void deleteAllPreviews()}
                    className="flex-1 h-9 items-center rounded-full bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    Delete All Previews
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-muted">
                  {deleteProgress || 'Deleting all previews…'}
                </p>
                <div className="h-2 bg-surface-raised rounded-full overflow-hidden">
                  <div className="h-full bg-red-600 animate-pulse" style={{ width: '100%' }} />
                </div>
                <p className="text-xs text-muted">
                  Keep this tab open until the deletion finishes. Deleting a large library can
                  take a while.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium tabular-nums text-foreground">{value}</dd>
    </div>
  );
}
