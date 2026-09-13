'use client';

/**
 * Connected MEGA Accounts panel.
 *
 * Renders each linked MEGA account with its live status, REAL sync progress
 * (pushed by the sync worker through /api/mega/accounts), management actions
 * (sync now / reconnect / disconnect), plus the "Add MEGA Account" flow. It
 * polls the accounts endpoint while any account is mid-sync so progress
 * updates without a page reload.
 *
 * Progress semantics (see lib/sync/progress.ts + lib/sync/eta.ts):
 *   - Phase A "scanning": node counter only, NO percentage (denominator
 *     unknown - a fake % is never shown).
 *   - Phase B "reconciling": real percentage = processedVideos / totalVideos,
 *     counters (created/updated/removed), elapsed time and an ETA computed
 *     from the observed processing rate (client-side sliding window).
 *   - After completion the durable MegaAccount.lastSyncMeta is shown
 *     (Sync complete / N videos / added-updated-removed / duration).
 *
 * Security notes: the panel only ever receives public account fields (no
 * session material). MEGA passwords are POSTed once for reconnect and never
 * kept in state beyond the submit.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

type Status =
  | 'CONNECTED'
  | 'SYNCING'
  | 'SYNCED'
  | 'REAUTH_REQUIRED'
  | 'ERROR'
  | 'DISCONNECTED';

interface SyncProgressDto {
  phase: 'starting' | 'scanning' | 'reconciling' | 'finalizing';
  startedAt: number;
  nodesScanned: number | null;
  totalVideos: number | null;
  processedVideos: number;
  created: number;
  updated: number;
  removed: number;
}

interface SyncMetaDto {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  discovered: number;
  totalVideos: number;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  outcome: 'completed' | 'failed' | 'interrupted';
}

interface AccountDto {
  id: number;
  label: string;
  megaEmail: string;
  megaUserId: string | null;
  status: Status;
  lastAuthenticatedAt: string | null;
  lastSyncStartedAt: string | null;
  lastSyncCompletedAt: string | null;
  lastSyncError: string | null;
  lastSyncMeta: SyncMetaDto | null;
  videoCount: number;
  createdAt: string;
  progress: SyncProgressDto | null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return 'never';
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)} minute${min === 1 ? '' : 's'} ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function statusMeta(status: Status): { dot: string; label: string } {
  switch (status) {
    case 'SYNCING':
      return { dot: 'bg-accent', label: 'Syncing…' };
    case 'SYNCED':
      return { dot: 'bg-success', label: 'Synced' };
    case 'CONNECTED':
      return { dot: 'bg-success', label: 'Connected' };
    case 'REAUTH_REQUIRED':
      return { dot: 'bg-warning', label: 'Re-authentication required' };
    case 'ERROR':
      return { dot: 'bg-warning', label: 'Sync failed' };
    case 'DISCONNECTED':
      return { dot: 'bg-muted-light', label: 'Disconnected' };
  }
}

// ---------------------------------------------------------------------------
// Live progress card (real worker state, no fake numbers)
// ---------------------------------------------------------------------------

const ETA_WARMUP_MS = 4_000;
const ETA_WARMUP_ITEMS = 5;
const ETA_ALMOST_DONE_THRESHOLD = 3;

interface EtaState {
  kind: 'calculating' | 'almost-done' | 'estimate';
  remainingMs?: number;
}

/** Sliding-window samples of (time, processed) for the ETA estimate. */
class ProgressSampler {
  private samples: Array<{ t: number; processed: number }> = [];

  push(processed: number): void {
    const t = Date.now();
    this.samples.push({ t, processed });
    // Keep ~2 minutes of history.
    const cutoff = t - 120_000;
    while (this.samples.length > 2 && this.samples[1].t < cutoff) this.samples.shift();
  }

  reset(): void {
    this.samples = [];
  }

  eta(totalVideos: number | null): EtaState {
    if (totalVideos === null) return { kind: 'calculating' };
    const last = this.samples[this.samples.length - 1];
    if (!last) return { kind: 'calculating' };
    const remaining = totalVideos - last.processed;
    if (remaining <= ETA_ALMOST_DONE_THRESHOLD) return { kind: 'almost-done' };
    const first = this.samples[0];
    const spanMs = last.t - first.t;
    const done = last.processed - first.processed;
    if (spanMs < ETA_WARMUP_MS || done < ETA_WARMUP_ITEMS) return { kind: 'calculating' };
    const ratePerMs = done / spanMs;
    if (!Number.isFinite(ratePerMs) || ratePerMs <= 0) return { kind: 'calculating' };
    const remainingMs = Math.ceil(remaining / ratePerMs);
    if (!Number.isFinite(remainingMs) || remainingMs < 0) return { kind: 'calculating' };
    return { kind: 'estimate', remainingMs };
  }
}

function SyncProgressCard({ progress }: { progress: SyncProgressDto }) {
  const samplerRef = useRef<ProgressSampler | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  // Snapshot derived from the sampler; updated in effects (never during render).
  const [eta, setEta] = useState<EtaState>({ kind: 'calculating' });

  // Lazily create the sampler outside render.
  useEffect(() => {
    if (!samplerRef.current) samplerRef.current = new ProgressSampler();
  }, []);

  // Feed the sampler on each progress change and recompute the ETA.
  useEffect(() => {
    const sampler = samplerRef.current;
    if (!sampler) return;
    sampler.push(progress.processedVideos);
    setEta(sampler.eta(progress.totalVideos));
  }, [progress.processedVideos, progress.totalVideos]);

  // Re-render once a second so elapsed time stays live.
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - progress.startedAt);
      const sampler = samplerRef.current;
      if (sampler) setEta(sampler.eta(progress.totalVideos));
    }, 1000);
    return () => clearInterval(timer);
  }, [progress.startedAt, progress.totalVideos]);

  const pct =
    progress.totalVideos !== null && progress.totalVideos > 0
      ? Math.min(100, Math.floor((progress.processedVideos / progress.totalVideos) * 100))
      : null;

  return (
    <div
      role="status"
      aria-label={pct === null ? 'Scanning MEGA account' : `Syncing library, ${pct} percent`}
      className="mt-3 rounded-2xl border border-border bg-surface p-4 text-[13px]"
    >
      {pct === null ? (
        <>
          <p className="font-semibold">Scanning MEGA…</p>
          <p className="mt-1 text-muted">
            {progress.nodesScanned !== null ? `${progress.nodesScanned.toLocaleString()} nodes scanned` : 'Preparing…'}
            {progress.totalVideos !== null && progress.totalVideos > 0
              ? ` · ${progress.totalVideos.toLocaleString()} videos found`
              : ''}
          </p>
          <p className="mt-1 text-muted">Elapsed: {formatDuration(elapsedMs)}</p>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="font-semibold">Syncing library</p>
            <p className="font-medium tabular-nums text-muted">{pct}%</p>
          </div>
          <div
            className="mt-2 h-2 w-full overflow-hidden rounded-full bg-background"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-muted">
            {progress.processedVideos.toLocaleString()} / {progress.totalVideos!.toLocaleString()} videos
          </p>
          <p className="mt-1 text-muted">
            {progress.updated} updated · {progress.created} new · {progress.removed} stale
          </p>
          <p className="mt-1 text-muted">Elapsed: {formatDuration(elapsedMs)}</p>
          <p className="text-muted">
            {eta.kind === 'estimate' && eta.remainingMs !== undefined
              ? `About ${formatDuration(eta.remainingMs)} remaining`
              : eta.kind === 'almost-done'
                ? 'Almost done…'
                : 'Calculating time remaining…'}
          </p>
        </>
      )}
    </div>
  );
}

/** Durable final result (from MegaAccount.lastSyncMeta). */
function SyncResultCard({ meta }: { meta: SyncMetaDto }) {
  if (meta.outcome === 'completed') {
    return (
      <div className="mt-3 rounded-2xl border border-success/30 bg-success/5 p-4 text-[13px]">
        <p className="font-semibold text-success">Sync complete</p>
        <p className="mt-1 text-muted">
          {meta.totalVideos.toLocaleString()} video{meta.totalVideos === 1 ? '' : 's'} ·{' '}
          {meta.created} added · {meta.updated} updated · {meta.removed} removed
        </p>
        <p className="mt-1 text-muted">Completed in {formatDuration(meta.durationMs)}</p>
      </div>
    );
  }
  if (meta.outcome === 'interrupted') {
    return (
      <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/5 p-4 text-[13px]">
        <p className="font-semibold text-warning">Sync was interrupted</p>
        <p className="mt-1 text-muted">It will be retried automatically.</p>
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-2xl border border-warning/30 bg-warning/5 p-4 text-[13px]">
      <p className="font-semibold text-warning">Last sync failed</p>
      <p className="mt-1 text-muted">Will retry automatically with backoff.</p>
    </div>
  );
}

export function MegaAccountsPanel() {
  const [accounts, setAccounts] = useState<AccountDto[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [addLabel, setAddLabel] = useState('');
  const [addEmail, setAddEmail] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addMfa, setAddMfa] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Per-account actions
  const [reauthFor, setReauthFor] = useState<number | null>(null);
  const [reauthPassword, setReauthPassword] = useState('');
  const [reauthMfa, setReauthMfa] = useState('');
  const [reauthBusy, setReauthBusy] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/mega/accounts', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load MEGA accounts');
      const data = (await res.json()) as { accounts: AccountDto[] };
      setAccounts(data.accounts);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load MEGA accounts');
    }
  }, []);

  // Initial load. setState runs in the fetch callback (an external-system
  // callback), not synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/mega/accounts', { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load MEGA accounts');
        return res.json() as Promise<{ accounts: AccountDto[] }>;
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
  }, []);

  // Poll while anything is in flight (syncing or awaiting first sync).
  useEffect(() => {
    const busy = (accounts ?? []).some(
      (a) => a.status === 'SYNCING' || a.status === 'CONNECTED',
    );
    if (busy) {
      if (!pollingRef.current) {
        pollingRef.current = setInterval(() => void load(), 2000);
      }
    } else if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [accounts, load]);

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddBusy(true);
    setAddError(null);
    try {
      const res = await fetch('/api/mega/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: addLabel,
          email: addEmail,
          password: addPassword,
          mfaCode: addMfa || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setAddError(data.error ?? 'Could not link this MEGA account.');
        return;
      }
      setAddLabel('');
      setAddEmail('');
      setAddPassword('');
      setAddMfa('');
      setShowAdd(false);
      await load();
    } catch {
      setAddError('Something went wrong. Try again.');
    } finally {
      setAddBusy(false);
    }
  }

  async function triggerSync(id: number) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/mega/accounts/${id}/sync`, { method: 'POST' });
      if (res.ok || res.status === 202) await load();
    } finally {
      setBusyId(null);
    }
  }

  async function submitReauth(id: number, e: React.FormEvent) {
    e.preventDefault();
    if (reauthBusy) return; // duplicate-submission guard
    setReauthBusy(true);
    setReauthError(null);
    try {
      const res = await fetch(`/api/mega/accounts/${id}/reauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: reauthPassword, mfaCode: reauthMfa || undefined }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setReauthPassword('');
        setReauthMfa('');
        setReauthError(data.error ?? 'Could not reconnect this MEGA account.');
        return;
      }
      setReauthFor(null);
      setReauthPassword('');
      setReauthMfa('');
      await load();
    } catch {
      setReauthPassword('');
      setReauthMfa('');
      setReauthError('Something went wrong. Try again.');
    } finally {
      setReauthBusy(false);
    }
  }

  async function disconnect(id: number) {
    const account = (accounts ?? []).find((a) => a.id === id);
    const ok = window.confirm(
      `Disconnect ${account?.label ?? 'this MEGA account'}? Its videos will be hidden until you link the same MEGA account again.`,
    );
    if (!ok) return;
    setBusyId(id);
    try {
      await fetch(`/api/mega/accounts/${id}`, { method: 'POST' });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  const anySyncing = (accounts ?? []).some((a) => a.status === 'SYNCING');

  return (
    <section aria-labelledby="mega-accounts-heading" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id="mega-accounts-heading" className="text-[15px] font-semibold">MEGA accounts</h2>
        <button
          type="button"
          onClick={() => {
            setShowAdd((v) => !v);
            setAddError(null);
          }}
          aria-expanded={showAdd}
          className={`inline-flex h-9 items-center rounded-full px-4 text-sm font-medium transition-colors ${
            showAdd
              ? 'bg-surface-raised text-foreground hover:bg-surface-overlay'
              : 'bg-accent text-white hover:bg-accent-hover'
          }`}
        >
          {showAdd ? 'Cancel' : '+ Add account'}
        </button>
      </div>

      {showAdd && (
        <form onSubmit={submitAdd} className="mb-5 space-y-4 rounded-2xl border border-border bg-background p-4 sm:p-5">
          <p className="text-sm leading-relaxed text-muted">
            Link a MEGA account to sync its private video library. Your MEGA password is used
            once to start a secure session and is never stored.
          </p>
          <div>
            <label htmlFor="mega-label" className="mb-1.5 block text-[13px] font-medium">
              Label <span className="font-normal text-muted">(optional)</span>
            </label>
            <input
              id="mega-label"
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              maxLength={50}
              placeholder="e.g. Main MEGA"
              className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm placeholder:text-muted-light focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="mega-email" className="mb-1.5 block text-[13px] font-medium">
              MEGA email
            </label>
            <input
              id="mega-email"
              type="email"
              required
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm placeholder:text-muted-light focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="mega-password" className="mb-1.5 block text-[13px] font-medium">
              MEGA password
            </label>
            <input
              id="mega-password"
              type="password"
              required
              autoComplete="new-password"
              value={addPassword}
              onChange={(e) => setAddPassword(e.target.value)}
              className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm placeholder:text-muted-light focus:border-accent focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="mega-mfa" className="mb-1.5 block text-[13px] font-medium">
              2FA code <span className="font-normal text-muted">(if enabled on this MEGA account)</span>
            </label>
            <input
              id="mega-mfa"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={addMfa}
              onChange={(e) => setAddMfa(e.target.value)}
              className="h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm placeholder:text-muted-light focus:border-accent focus:outline-none"
            />
          </div>
          {addError && <p role="alert" className="text-sm text-destructive">{addError}</p>}
          <button
            type="submit"
            disabled={addBusy}
            className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {addBusy ? 'Connecting…' : 'Connect MEGA account'}
          </button>
        </form>
      )}

      {loadError && <p role="alert" className="mb-4 text-sm text-destructive">{loadError}</p>}

      {accounts === null ? (
        <div className="space-y-3" role="status" aria-label="Loading MEGA accounts">
          <div className="mt-skeleton h-[76px] rounded-2xl" />
          <div className="mt-skeleton h-[76px] rounded-2xl" />
          <span className="sr-only">Loading MEGA accounts…</span>
        </div>
      ) : accounts.length === 0 ? (
        <p className="text-sm leading-relaxed text-muted">
          No MEGA accounts linked yet. Add one above to sync your private video
          library.
        </p>
      ) : (
        <ul className="space-y-3">
          {accounts.map((a) => {
            const meta = statusMeta(a.status);
            const active = busyId === a.id;
            const live = a.status === 'SYNCING' ? a.progress : null;
            return (
              <li key={a.id} className="rounded-2xl border border-border bg-background p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${meta.dot} ${
                          a.status === 'SYNCING' ? 'animate-pulse' : ''
                        }`}
                        aria-hidden
                      />
                      <span className="truncate">{a.label}</span>
                      <span className="sr-only">— {meta.label}</span>
                    </p>
                    <p className="mt-0.5 truncate text-[13px] text-muted">
                      {a.megaEmail}
                    </p>
                    {a.status !== 'SYNCING' && (
                      <p className="mt-1 text-xs text-muted">
                        {a.status === 'DISCONNECTED'
                          ? 'Disconnected'
                          : a.status === 'REAUTH_REQUIRED'
                            ? 'Session expired — reconnect to sync again'
                            : a.status === 'ERROR'
                              ? 'Sync failed'
                              : a.status === 'CONNECTED'
                                ? 'Connected — not yet synced'
                                : `Last synced ${relativeTime(a.lastSyncCompletedAt)}`}
                      </p>
                    )}
                    {a.status !== 'DISCONNECTED' && (
                      <p className="mt-0.5 text-xs text-muted">
                        {a.videoCount} video{a.videoCount === 1 ? '' : 's'}
                      </p>
                    )}
                    {a.status === 'ERROR' && a.lastSyncError && (
                      <p className="mt-1 text-xs text-destructive">{a.lastSyncError}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {a.status !== 'DISCONNECTED' && a.status !== 'REAUTH_REQUIRED' && (
                      <button
                        type="button"
                        onClick={() => void triggerSync(a.id)}
                        disabled={active || a.status === 'SYNCING'}
                        className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-[13px] font-medium transition-colors hover:bg-surface-overlay disabled:opacity-50"
                      >
                        {a.status === 'SYNCING' ? 'Syncing…' : 'Sync now'}
                      </button>
                    )}
                    {a.status === 'REAUTH_REQUIRED' && (
                      <button
                        type="button"
                        onClick={() => {
                          setReauthFor(a.id);
                          setReauthError(null);
                        }}
                        disabled={active}
                        className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
                      >
                        Reconnect
                      </button>
                    )}
                    {a.status !== 'DISCONNECTED' && (
                      <button
                        type="button"
                        onClick={() => void disconnect(a.id)}
                        disabled={active || a.status === 'SYNCING'}
                        className="inline-flex h-9 items-center rounded-full px-4 text-[13px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>

                {/* Live progress from the worker (Phase A + Phase B). */}
                {live && <SyncProgressCard progress={live} />}

                {/* Durable last-sync result (also shown right after completion). */}
                {a.status !== 'SYNCING' && a.lastSyncMeta && a.status !== 'REAUTH_REQUIRED' && (
                  <SyncResultCard meta={a.lastSyncMeta} />
                )}

                {reauthFor === a.id && (
                  <form
                    onSubmit={(e) => void submitReauth(a.id, e)}
                    className="mt-3 space-y-3 rounded-2xl border border-border bg-surface p-4"
                  >
                    <p className="text-[13px] leading-relaxed text-muted">
                      This MEGA session expired or was revoked. Enter your MEGA password to
                      reconnect — used once, never stored.
                    </p>
                    <input
                      type="password"
                      required
                      autoComplete="new-password"
                      placeholder="MEGA password"
                      value={reauthPassword}
                      onChange={(e) => setReauthPassword(e.target.value)}
                      disabled={reauthBusy}
                      className="h-11 w-full rounded-xl border border-border bg-background px-4 text-sm placeholder:text-muted-light focus:border-accent focus:outline-none"
                      aria-label={`MEGA password for ${a.label}`}
                    />
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="2FA code (if required)"
                      value={reauthMfa}
                      onChange={(e) => setReauthMfa(e.target.value)}
                      disabled={reauthBusy}
                      className="h-11 w-full rounded-xl border border-border bg-background px-4 text-sm placeholder:text-muted-light focus:border-accent focus:outline-none"
                      aria-label={`2FA code for ${a.label}`}
                    />
                    {reauthError && <p role="alert" className="text-[13px] text-destructive">{reauthError}</p>}
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={reauthBusy || !reauthPassword}
                        className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {reauthBusy ? 'Reconnecting…' : 'Reconnect'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReauthFor(null);
                          setReauthError(null);
                          setReauthPassword('');
                          setReauthMfa('');
                        }}
                        disabled={reauthBusy}
                        className="inline-flex h-10 items-center rounded-full px-4 text-sm font-medium text-muted hover:bg-surface-hover hover:text-foreground"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {anySyncing && (
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Sync runs in the background — the rest of the site stays usable.
        </p>
      )}
    </section>
  );
}
