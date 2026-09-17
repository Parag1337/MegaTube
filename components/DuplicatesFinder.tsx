'use client';

/**
 * Find Duplicates UI.
 *
 * Lives inside the MEGA account area (/account/duplicates). Lists POSSIBLE
 * duplicate groups (heuristic title + size match, never proven identical) in
 * a checkbox list view with the evidence behind each group; nothing is ever
 * pre-selected and the user decides what to delete. Deletion requires an
 * explicit confirmation dialog and reports partial results honestly
 * (deleted vs. failed counts).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui';
import { ThumbImage } from '@/components/ThumbImage';
import { FilmIcon } from '@/components/icons';

interface AccountOption {
  id: number;
  label: string;
  megaEmail: string;
  status: string;
  videoCount: number;
}

interface DuplicateCopyDto {
  videoId: number;
  nodeId: string;
  name: string;
  parentNodeId: string | null;
  size: number | null;
  duration: number | null;
  title: string;
  creatorName: string | null;
  thumbnail: string | null;
  mimeType: string | null;
  megaModifiedAt: string | null;
  accountId: number | null;
  accountLabel: string | null;
}

interface DuplicateGroupDto {
  groupKey: string;
  copies: DuplicateCopyDto[];
  totalCopies: number;
  potentialSavings: number;
  representativeTitle: string;
  confidence: 'high' | 'possible';
  minTitleSim: number;
  sameSizeBytes: number;
  durationStatus: 'same' | 'partial-unknown' | 'unknown';
  representativeDuration: number | null;
  extensions: string[];
}

interface ScanResult {
  scope: 'all' | number;
  accounts: AccountOption[];
  groups: DuplicateGroupDto[];
  potentialGroups: DuplicateGroupDto[];
  summary: {
    duplicateGroups: number;
    duplicateFiles: number;
    potentialSavingsBytes: number;
    potentialGroups: number;
    scannedVideos: number;
  };
}

interface DeleteResponse {
  deleted?: Array<{ nodeId: string; videoId: number; accountId?: number | null; accountLabel?: string | null; alreadyGone: boolean }>;
  failed?: Array<{ nodeId: string; videoId: number | null; accountId?: number | null; reason: string }>;
  syncQueued?: boolean;
  error?: string;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do {
    v /= 1024;
    u++;
  } while (v >= 1024 && u < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds)) return '—';
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function DuplicatesFinder({ initialAccountId }: { initialAccountId: number | null }) {
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Scan scope: 'all' (every owned account pooled) or one account id.
  const [scope, setScope] = useState<'all' | number>(initialAccountId ?? 'all');
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'done'>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteOutcome, setDeleteOutcome] = useState<DeleteResponse | null>(null);

  // Account list (public fields only, same source as MegaAccountsPanel).
  useEffect(() => {
    let cancelled = false;
    fetch('/api/mega/accounts', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load MEGA accounts');
        return res.json() as Promise<{ accounts: AccountOption[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setAccounts(data.accounts);
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : 'Failed to load MEGA accounts');
      });
    return () => {
      cancelled = true;
    };
  }, [initialAccountId]);

  const scan = useCallback(async () => {
    setScanState('scanning');
    setScanError(null);
    setResult(null);
    setSelected(new Set());
    setDeleteOutcome(null);
    setDeleteError(null);
    setConfirmOpen(false);
    try {
      const res = await fetch(`/api/mega/duplicates?accountId=${scope}`, { cache: 'no-store' });
      const data = (await res.json().catch(() => ({}))) as ScanResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Could not scan for duplicates.');
      setResult(data);
      if (data.accounts) setAccounts(data.accounts);
      setScanState('done');
    } catch (err) {
      setScanError(err instanceof Error ? err.message : 'Could not scan for duplicates.');
      setScanState('idle');
    }
  }, [scope]);

  const toggle = useCallback((nodeId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  /** Explicit, reviewable helper: select every copy except the first in a group. */
  const selectAllButFirst = useCallback((group: DuplicateGroupDto) => {
    setSelected((prev) => {
      const next = new Set(prev);
      group.copies.slice(1).forEach((c) => next.add(c.nodeId));
      return next;
    });
  }, []);

  const clearGroupSelection = useCallback((group: DuplicateGroupDto) => {
    setSelected((prev) => {
      const next = new Set(prev);
      group.copies.forEach((c) => next.delete(c.nodeId));
      return next;
    });
  }, []);

  const selectedCopies = useMemo(() => {
    if (!result) return [];
    const out: Array<DuplicateCopyDto & { groupTitle: string }> = [];
    for (const g of result.groups) {
      for (const c of g.copies) {
        if (selected.has(c.nodeId)) out.push({ ...c, groupTitle: g.representativeTitle });
      }
    }
    return out;
  }, [result, selected]);

  const selectedBytes = useMemo(
    () => selectedCopies.reduce((n, c) => n + (c.size ?? 0), 0),
    [selectedCopies],
  );

  const confirmDelete = useCallback(async () => {
    if (selected.size === 0 || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/mega/duplicates', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeIds: [...selected] }),
      });
      const data = (await res.json().catch(() => ({}))) as DeleteResponse;
      if (!res.ok) {
        setDeleteError(data.error ?? 'Could not delete the selected files.');
        // Partial outcomes may still be present (e.g. 409 after some deletes).
        if (data.deleted?.length || data.failed?.length) setDeleteOutcome(data);
        return;
      }
      setDeleteOutcome(data);
      setConfirmOpen(false);
      // Drop successfully deleted rows from the selection; keep failures
      // selected so the user can retry them.
      const gone = new Set((data.deleted ?? []).map((d) => d.nodeId));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const n of gone) next.delete(n);
        return next;
      });
    } catch {
      setDeleteError('Something went wrong. Try again.');
    } finally {
      setDeleting(false);
    }
  }, [selected, deleting]);

  const deletedCount = deleteOutcome?.deleted?.length ?? 0;
  const failedCount = deleteOutcome?.failed?.length ?? 0;
  const totalAccountVideos = (accounts ?? []).reduce((n, a) => n + a.videoCount, 0);
  const canScan = scanState !== 'scanning' && (accounts ?? []).length > 0 && totalAccountVideos > 0;

  return (
    <div className="space-y-4">
      {loadError && (
        <p role="alert" className="text-sm text-destructive">{loadError}</p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1">
          <label htmlFor="dup-scope" className="mb-1.5 block text-[13px] font-medium">
            Scan scope
          </label>
          <select
            id="dup-scope"
            value={scope}
            onChange={(e) => {
              const v = e.target.value;
              setScope(v === 'all' ? 'all' : Number(v));
              setResult(null);
              setScanState('idle');
              setScanError(null);
              setSelected(new Set());
              setDeleteOutcome(null);
            }}
            className="h-11 w-full rounded-xl border border-border bg-background px-3 text-sm focus:border-accent focus:outline-none"
          >
            <option value="all">
              All MEGA accounts — {totalAccountVideos.toLocaleString()} videos
            </option>
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.label} ({a.megaEmail}) — {a.videoCount} videos
              </option>
            ))}
          </select>
        </div>
        <Button variant="primary" disabled={!canScan} onClick={() => void scan()}>
          {scanState === 'scanning' ? 'Scanning…' : 'Scan for duplicates'}
        </Button>
      </div>

      {accounts !== null && accounts.length === 0 && (
        <p role="status" className="rounded-2xl border border-border bg-background p-4 text-sm text-muted">
          Connect a MEGA account to scan for duplicates.
        </p>
      )}
      {accounts !== null && accounts.length > 0 && totalAccountVideos === 0 && (
        <p role="status" className="rounded-2xl border border-border bg-background p-4 text-sm text-muted">
          No videos available to scan.
        </p>
      )}

      {scanState === 'scanning' && (
        <p role="status" className="text-sm text-muted">Scanning for duplicates…</p>
      )}
      {scanError && (
        <p role="alert" className="text-sm text-destructive">{scanError}</p>
      )}

      {scanState === 'done' && result && (
        <>
          {result.summary.duplicateGroups === 0 ? (
            <p role="status" className="rounded-2xl border border-border bg-background p-4 text-sm text-muted">
              No duplicate candidates found.
            </p>
          ) : (
            <div role="status" className="rounded-2xl border border-border bg-background p-4 text-sm">
              <p className="font-semibold">Possible duplicates</p>
              <p className="mt-0.5 text-muted">
                {result.summary.duplicateGroups} group{result.summary.duplicateGroups === 1 ? '' : 's'} ·{' '}
                {result.summary.duplicateFiles} duplicate candidate{result.summary.duplicateFiles === 1 ? '' : 's'} ·{' '}
                {formatBytes(result.summary.potentialSavingsBytes)} potential storage savings
              </p>
            </div>
          )}

          <ul className="space-y-4">
            {result.groups.map((g) => {
              const selectedInGroup = g.copies.filter((c) => selected.has(c.nodeId)).length;
              return (
                <li key={g.groupKey} className="rounded-2xl border border-border bg-background p-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        Possible duplicate
                        <span className="ml-2 rounded-full bg-surface-raised px-2 py-0.5 text-xs font-normal text-muted">
                          {g.confidence === 'high' ? 'high confidence' : 'possible match'}
                        </span>
                      </p>
                      <p className="truncate text-[13px] text-muted">{g.representativeTitle}</p>
                      <p className="mt-1 text-xs text-muted">
                        {g.minTitleSim}% title match · Same size: {formatBytes(g.sameSizeBytes)}
                        {g.durationStatus === 'same' && g.representativeDuration !== null
                          ? ` · Same duration: ${formatDuration(g.representativeDuration)}`
                          : g.durationStatus === 'partial-unknown'
                            ? ' · Duration unknown for some copies'
                            : ' · Duration unknown'}
                      </p>
                      {g.extensions.length > 1 && (
                        <p className="mt-0.5 text-xs text-warning">
                          Mixed formats: {g.extensions.join(', ')} — compare carefully before deleting.
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[13px]">
                      <button
                        type="button"
                        onClick={() => selectAllButFirst(g)}
                        className="rounded-full px-3 py-1.5 font-medium text-muted hover:bg-surface-hover hover:text-foreground"
                      >
                        Select all but first
                      </button>
                      {selectedInGroup > 0 && (
                        <button
                          type="button"
                          onClick={() => clearGroupSelection(g)}
                          className="rounded-full px-3 py-1.5 font-medium text-muted hover:bg-surface-hover hover:text-foreground"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  <ul className="mt-3 space-y-2">
                    {g.copies.map((c, i) => (
                      <li key={c.nodeId}>
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface p-3 hover:border-muted-light">
                          <input
                            type="checkbox"
                            checked={selected.has(c.nodeId)}
                            onChange={() => toggle(c.nodeId)}
                            aria-label={`Select copy ${i + 1} of ${c.name}`}
                            className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                          />
                          {/* Stored thumbnail reference only (same display
                              rule as VideoCard: ThumbImage when present, the
                              FilmIcon placeholder otherwise). Nothing is
                              generated or downloaded for this scan. */}
                          <span className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-surface-raised sm:w-36" aria-hidden>
                            {c.thumbnail ? (
                              <ThumbImage src={c.thumbnail} />
                            ) : (
                              <span className="flex h-full w-full items-center justify-center">
                                <FilmIcon className="h-6 w-6 text-muted-light" />
                              </span>
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">
                              Copy {i + 1}
                              {i === 0 && <span className="ml-2 rounded-full bg-surface-raised px-2 py-0.5 text-xs font-normal text-muted">oldest</span>}
                            </span>
                            {c.accountLabel && (
                              <span className="block text-[13px] font-medium text-muted">{c.accountLabel}</span>
                            )}
                            <span className="block truncate text-[13px] text-muted">{c.name}</span>
                            <span className="mt-0.5 block text-xs text-muted">
                              {formatBytes(c.size)} · {formatDuration(c.duration)}
                              {c.creatorName ? ` · ${c.creatorName}` : ''}
                            </span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>

                  <p className="mt-2 text-xs text-muted">
                    Selected: {selectedInGroup} of {g.totalCopies}
                  </p>
                </li>
              );
            })}
          </ul>

          {result.groups.length > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4">
              <p className="text-sm">
                Selected: <span className="font-semibold">{selected.size}</span>
                {selected.size > 0 && (
                  <span className="text-muted"> · {formatBytes(selectedBytes)} to free</span>
                )}
              </p>
              <Button variant="danger" disabled={selected.size === 0} onClick={() => { setDeleteError(null); setConfirmOpen(true); }}>
                Delete selected from MEGA
              </Button>
            </div>
          )}
        </>
      )}

      {deleteOutcome && (
        <div role="status" className="rounded-2xl border border-border bg-background p-4 text-sm">
          {failedCount === 0 ? (
            <p className="font-semibold text-success">
              {deletedCount} file{deletedCount === 1 ? '' : 's'} deleted from MEGA.
            </p>
          ) : (
            <p className="font-semibold text-warning">
              {deletedCount} file{deletedCount === 1 ? '' : 's'} deleted. {failedCount} could not be deleted.
            </p>
          )}
          {deleteOutcome.syncQueued && (
            <p className="mt-1 text-muted">Syncing your library to reflect the deletions…</p>
          )}
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => void scan()}>
              Rescan for duplicates
            </Button>
          </div>
        </div>
      )}
      {deleteError && (
        <p role="alert" className="text-sm text-destructive">{deleteError}</p>
      )}

      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="dup-confirm-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setConfirmOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5">
            <h2 id="dup-confirm-title" className="text-[15px] font-semibold">
              Delete {selectedCopies.length} file{selectedCopies.length === 1 ? '' : 's'} from MEGA?
            </h2>
            <p className="mt-2 text-sm text-muted">
              These files will be removed from your MEGA account. This cannot be undone.
            </p>
            <ul className="mt-3 max-h-48 space-y-1 overflow-auto rounded-xl bg-background p-3 text-[13px]">
              {selectedCopies.map((c) => (
                <li key={c.nodeId} className="truncate">• {c.accountLabel ? `${c.accountLabel} — ` : ''}{c.name}</li>
              ))}
            </ul>
            <p className="mt-3 text-sm">
              Space to be freed: <span className="font-semibold">{formatBytes(selectedBytes)}</span>
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" disabled={deleting} onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? `Deleting ${selectedCopies.length} files…` : 'Delete from MEGA'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
