'use client';

/**
 * Repair Thumbnails full-page dashboard.
 *
 * Reuses the EXISTING thumbnail repair backend (`POST /api/thumbs/repair`,
 * NDJSON progress events from `lib/thumbs/repair.ts` /
 * `repairVideoThumbnail()`): `started`, `video-start`, `video-phase`
 * (`repairing` / `extracting`), `video-done`, `summary`. No change to the
 * repair algorithm, batching, mutex (429 while a run is in flight), or
 * classification — this is a presentation layer over the same stream the
 * former inline `RepairThumbsButton` consumed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { FilmIcon } from '@/components/icons';

type RepairStatus =
  | 'skipped-good'
  | 'repaired-missing'
  | 'repaired-black'
  | 'repaired-broken'
  | 'repaired-problematic'
  | 'repaired'
  | 'failed'
  | 'not-found'
  | 'skipped-cap';

interface RepairCounts {
  scanned: number;
  repaired: number;
  repairedMissing: number;
  repairedBlack: number;
  repairedBroken: number;
  repairedProblematic: number;
  skippedGood: number;
  notFound: number;
  failed: number;
}

interface LogEntry {
  videoId: number;
  title: string;
  stage: 'start' | 'repairing' | 'extracting' | 'done';
  category?: RepairStatus;
  status?: RepairStatus;
  detail?: string;
  elapsedMs?: number;
  index?: number;
  total?: number;
}

function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function categoryLabel(category: RepairStatus): string {
  switch (category) {
    case 'repaired-problematic':
      return 'Previously problematic video';
    case 'repaired-black':
      return 'Black thumbnail';
    case 'repaired-missing':
      return 'Missing thumbnail';
    case 'repaired-broken':
      return 'Broken thumbnail';
    default:
      return 'Repairing';
  }
}

function statusLabel(entry: LogEntry): string {
  switch (entry.status) {
    case 'skipped-good':
      return 'Looks good — skipped';
    case 'repaired-missing':
    case 'repaired-black':
    case 'repaired-broken':
    case 'repaired-problematic':
    case 'repaired':
      return 'Repair successful';
    case 'not-found':
      return 'Still unavailable — source unavailable';
    case 'skipped-cap':
      return 'Skipped (batch cap)';
    case 'failed':
      return `Repair failed${entry.detail ? ` — ${entry.detail}` : ''}`;
    default:
      return entry.status ?? '';
  }
}

function phaseLabel(stage: LogEntry['stage']): string {
  switch (stage) {
    case 'start':
      return 'Classifying';
    case 'repairing':
      return 'Repairing';
    case 'extracting':
      return 'Extracting frame';
    case 'done':
      return 'Done';
  }
}

function statusTone(entry: LogEntry): 'ok' | 'warn' | 'bad' | 'muted' | 'live' {
  if (entry.stage !== 'done') return 'live';
  switch (entry.status) {
    case 'skipped-good':
      return 'muted';
    case 'repaired-missing':
    case 'repaired-black':
    case 'repaired-broken':
    case 'repaired-problematic':
    case 'repaired':
      return 'ok';
    case 'not-found':
    case 'skipped-cap':
      return 'warn';
    case 'failed':
      return 'bad';
    default:
      return 'muted';
  }
}

const toneClass: Record<string, string> = {
  ok: 'bg-success/15 text-success',
  warn: 'bg-warning/15 text-warning',
  bad: 'bg-destructive/15 text-destructive',
  muted: 'bg-surface-raised text-muted',
  live: 'bg-accent/15 text-accent',
};

function RepairThumb({ videoId, title }: { videoId: number; title: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <span className="flex h-full w-full items-center justify-center bg-surface-raised">
        <FilmIcon className="h-6 w-6 text-muted-light" />
      </span>
    );
  }
  return (
    <img
      src={`/api/media/thumbs/${videoId}`}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setBroken(true)}
      className="h-full w-full object-cover"
      aria-label={`Thumbnail for ${title}`}
    />
  );
}

export function RepairDashboard() {
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<RepairCounts | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const logRef = useRef<HTMLDivElement>(null);

  // Live clock while running so elapsed / ETA stay fresh.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  function scrollToBottom() {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function upsert(patch: LogEntry) {
    setEntries((prev) => {
      const i = prev.findIndex((e) => e.videoId === patch.videoId);
      if (i < 0) return [...prev, patch];
      const next = prev.slice();
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }

  async function run() {
    setRunning(true);
    setError('');
    setSummary(null);
    setEntries([]);
    setTotal(null);
    setDone(false);
    setStartedAt(Date.now());
    setNow(Date.now());
    try {
      const res = await fetch('/api/thumbs/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 429) throw new Error('A repair is already running — try again in a bit.');
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((data as { error?: string } | null)?.error || 'Repair failed.');
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('ndjson') || !res.body) {
        const data = (await res.json().catch(() => null)) as RepairCounts | null;
        if (!data) throw new Error('Repair failed.');
        setSummary(data);
        setDone(true);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const handleLine = (line: string) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const type = msg.type as string;
        if (type === 'started') {
          setTotal(typeof msg.total === 'number' ? msg.total : null);
        } else if (type === 'video-start') {
          const videoId = msg.videoId as number;
          upsert({
            videoId,
            title: (msg.title as string) || `Video ${videoId}`,
            stage: 'start',
            index: msg.index as number | undefined,
            total: msg.total as number | undefined,
          });
          if (typeof msg.total === 'number') setTotal(msg.total as number);
          queueMicrotask(scrollToBottom);
        } else if (type === 'video-phase') {
          const videoId = msg.videoId as number;
          const phase = msg.phase as 'repairing' | 'extracting';
          upsert({
            videoId,
            title: (msg.title as string) || `Video ${videoId}`,
            stage: phase,
            category: msg.category as RepairStatus | undefined,
          });
          queueMicrotask(scrollToBottom);
        } else if (type === 'video-done') {
          const videoId = msg.videoId as number;
          upsert({
            videoId,
            title: (msg.title as string) || `Video ${videoId}`,
            stage: 'done',
            status: msg.status as RepairStatus,
            detail: msg.detail as string | undefined,
            elapsedMs: msg.elapsedMs as number | undefined,
          });
          queueMicrotask(scrollToBottom);
        } else if (type === 'summary') {
          const s = msg.summary as RepairCounts;
          setSummary({
            scanned: s.scanned ?? 0,
            repaired: s.repaired ?? 0,
            repairedMissing: s.repairedMissing ?? 0,
            repairedBlack: s.repairedBlack ?? 0,
            repairedBroken: s.repairedBroken ?? 0,
            repairedProblematic: s.repairedProblematic ?? 0,
            skippedGood: s.skippedGood ?? 0,
            notFound: s.notFound ?? 0,
            failed: s.failed ?? 0,
          });
          setDone(true);
          queueMicrotask(scrollToBottom);
        } else if (type === 'error') {
          throw new Error((msg.error as string) || 'Repair failed.');
        }
      };
      for (;;) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) {
          if (buf.trim().length > 0) handleLine(buf);
          break;
        }
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.length > 0) handleLine(line);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRunning(false);
      setNow(Date.now());
      queueMicrotask(scrollToBottom);
    }
  }

  const processed = useMemo(() => entries.filter((e) => e.stage === 'done').length, [entries]);
  const repairedLive = useMemo(
    () =>
      entries.filter(
        (e) =>
          e.stage === 'done' &&
          (e.status === 'repaired' ||
            e.status === 'repaired-missing' ||
            e.status === 'repaired-black' ||
            e.status === 'repaired-broken' ||
            e.status === 'repaired-problematic'),
      ).length,
    [entries],
  );
  const skippedLive = useMemo(
    () => entries.filter((e) => e.stage === 'done' && e.status === 'skipped-good').length,
    [entries],
  );
  const failedLive = useMemo(
    () => entries.filter((e) => e.stage === 'done' && e.status === 'failed').length,
    [entries],
  );
  const notFoundLive = useMemo(
    () => entries.filter((e) => e.stage === 'done' && e.status === 'not-found').length,
    [entries],
  );

  const effectiveTotal = total ?? (done && summary ? summary.scanned : null);
  const remaining = effectiveTotal !== null ? Math.max(0, effectiveTotal - processed) : null;
  const pct =
    effectiveTotal !== null && effectiveTotal > 0
      ? Math.min(100, Math.floor((processed / effectiveTotal) * 100))
      : null;

  const active = useMemo(
    () => [...entries].reverse().find((e) => e.stage !== 'done') ?? null,
    [entries],
  );
  const currentPhase = running
    ? active
      ? `${phaseLabel(active.stage)} — ${active.title}`
      : processed > 0
        ? 'Wrapping up…'
        : 'Starting…'
    : done
      ? 'Finished'
      : 'Idle';

  const elapsedMs = startedAt !== null ? Math.max(0, now - startedAt) : 0;
  // ETA from the observed client-side rate (same idea as the sync panel:
  // never shown before enough samples, honest "calculating" otherwise).
  const etaMs = useMemo(() => {
    if (!running || !startedAt || processed < 3 || remaining === null || remaining <= 0) return null;
    const elapsed = now - startedAt;
    if (elapsed < 4000) return null;
    const rate = processed / elapsed;
    if (!Number.isFinite(rate) || rate <= 0) return null;
    const eta = Math.ceil(remaining / rate);
    return Number.isFinite(eta) && eta >= 0 ? eta : null;
  }, [running, startedAt, processed, remaining, now]);

  const finished = done && summary !== null;

  return (
    <div className="space-y-5">
      {/* Controls */}
      <section
        aria-label="Repair controls"
        className="rounded-2xl border border-border bg-surface p-5 sm:p-6"
      >
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void run()}
            disabled={running}
            className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            {running ? 'Repairing…' : entries.length > 0 ? 'Run repair again' : 'Start repair'}
          </button>
          {running && effectiveTotal !== null ? (
            <p className="text-[13px] text-muted" role="status">
              Repairing thumbnails… ({processed}/{effectiveTotal})
            </p>
          ) : !running && entries.length === 0 ? (
            <p className="text-[13px] text-muted">
              Scans your whole library. Safe to re-run any time.
            </p>
          ) : null}
        </div>
        {pct !== null && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-[13px]">
              <span className="font-medium">
                {processed} / {effectiveTotal} processed
              </span>
              <span className="font-medium tabular-nums text-muted">{pct}%</span>
            </div>
            <div
              className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-background"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Repair progress, ${pct} percent`}
            >
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}
      </section>

      {/* Live stats */}
      <section
        aria-label="Repair progress"
        className="rounded-2xl border border-border bg-surface p-5 sm:p-6"
      >
        <h2 className="text-[15px] font-semibold">Live progress</h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Total videos</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {effectiveTotal !== null ? effectiveTotal.toLocaleString() : '—'}
            </dd>
          </div>
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Processed</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {processed.toLocaleString()}
            </dd>
          </div>
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Remaining</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {remaining !== null ? remaining.toLocaleString() : '—'}
            </dd>
          </div>
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Current phase</dt>
            <dd className="mt-0.5 truncate text-lg font-semibold" title={currentPhase}>
              {running || done ? currentPhase.split(' — ')[0] : 'Idle'}
            </dd>
          </div>
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Repaired</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-success">
              {finished && summary ? summary.repaired : repairedLive}
            </dd>
          </div>
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Skipped (good)</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums">
              {finished && summary ? summary.skippedGood : skippedLive}
            </dd>
          </div>
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Failed</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-destructive">
              {finished && summary ? summary.failed : failedLive}
            </dd>
          </div>
          <div className="rounded-xl bg-background p-3">
            <dt className="text-muted">Unavailable</dt>
            <dd className="mt-0.5 text-lg font-semibold tabular-nums text-warning">
              {finished && summary ? summary.notFound : notFoundLive}
            </dd>
          </div>
        </dl>
        <div className="mt-3 space-y-1 text-[13px] text-muted">
          <p>
            <span className="font-medium text-foreground">Current video: </span>
            {running || done
              ? (active?.title ?? (done ? '—' : 'Preparing…'))
              : 'Press “Start repair” to begin.'}
          </p>
          <p>
            <span className="font-medium text-foreground">Status: </span>
            {running ? currentPhase : done ? 'Finished' : 'Idle'}
          </p>
          <p>
            Elapsed: {startedAt !== null ? formatDuration(elapsedMs) : '—'}
            {' · '}
            Remaining: {etaMs !== null ? `about ${formatDuration(etaMs)}` : running ? 'calculating…' : '—'}
          </p>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            {error}
          </p>
        )}
      </section>

      {/* Final summary */}
      {finished && summary && (
        <section
          aria-label="Repair summary"
          role="status"
          className="rounded-2xl border border-success/30 bg-success/5 p-5 sm:p-6"
        >
          <h2 className="text-[15px] font-semibold text-success">Repair complete</h2>
          <p className="mt-1 text-[13px] text-muted">
            Scanned {summary.scanned} video{summary.scanned === 1 ? '' : 's'} in{' '}
            {startedAt !== null ? formatDuration(elapsedMs) : '—'}.
          </p>
          <ul className="mt-3 grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-3">
            <li className="rounded-xl bg-surface p-3">✓ Repaired total: <span className="font-semibold">{summary.repaired}</span></li>
            <li className="rounded-xl bg-surface p-3">✓ Missing repaired: <span className="font-semibold">{summary.repairedMissing}</span></li>
            <li className="rounded-xl bg-surface p-3">✓ Black repaired: <span className="font-semibold">{summary.repairedBlack}</span></li>
            <li className="rounded-xl bg-surface p-3">✓ Broken repaired: <span className="font-semibold">{summary.repairedBroken}</span></li>
            <li className="rounded-xl bg-surface p-3">✓ Problematic repaired: <span className="font-semibold">{summary.repairedProblematic}</span></li>
            <li className="rounded-xl bg-surface p-3">✓ Good skipped: <span className="font-semibold">{summary.skippedGood}</span></li>
            <li className="rounded-xl bg-surface p-3">⚠ Still unavailable: <span className="font-semibold">{summary.notFound}</span></li>
            <li className="rounded-xl bg-surface p-3">✗ Failed: <span className="font-semibold">{summary.failed}</span></li>
          </ul>
        </section>
      )}

      {/* Live activity */}
      <section
        aria-label="Repair activity"
        className="rounded-2xl border border-border bg-surface p-5 sm:p-6"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[15px] font-semibold">Activity</h2>
          {entries.length > 0 && (
            <p className="text-xs text-muted" role="status">
              {processed} of {effectiveTotal ?? '?'} finished
            </p>
          )}
        </div>
        {entries.length === 0 ? (
          <p className="mt-3 rounded-xl bg-background p-4 text-sm text-muted">
            Nothing repaired yet. Start a run to watch each video move through
            classifying → repairing → extracting a frame, with per-video timing.
          </p>
        ) : (
          <div
            ref={logRef}
            aria-live="polite"
            className="mt-3 max-h-[560px] space-y-2 overflow-y-auto rounded-xl bg-background p-3"
          >
            {entries.map((e) => {
              const tone = statusTone(e);
              return (
                <div
                  key={e.videoId}
                  className="flex items-start gap-3 rounded-xl border border-border bg-surface p-3"
                >
                  <span className="relative aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-surface-raised sm:w-32" aria-hidden>
                    <RepairThumb videoId={e.videoId} title={e.title} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{e.title}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${toneClass[tone]}`}
                      >
                        {e.stage === 'done' ? statusLabel(e).split(' — ')[0] : phaseLabel(e.stage)}
                      </span>
                    </span>
                    <span className="mt-1 block text-xs text-muted">
                      Video #{e.videoId}
                      {typeof e.index === 'number' && typeof (e.total ?? effectiveTotal) === 'number'
                        ? ` · ${e.index}/${e.total ?? effectiveTotal}`
                        : ''}
                      {e.stage !== 'start' && e.stage !== 'done' && e.category
                        ? ` · ${categoryLabel(e.category)}`
                        : ''}
                      {e.stage === 'done' &&
                      e.status !== 'skipped-good' &&
                      e.status !== 'failed' &&
                      e.status !== 'not-found' &&
                      e.status !== 'skipped-cap'
                        ? ` · ${categoryLabel((e.category ?? e.status ?? 'repaired') as RepairStatus)}`
                        : ''}
                    </span>
                    {e.stage !== 'done' && (
                      <span className="mt-0.5 block text-xs text-muted">
                        {e.stage === 'start' ? 'Classifying…' : e.stage === 'repairing' ? '↳ Repairing…' : '↳ Repairing… ↳ Extracting frame…'}
                      </span>
                    )}
                    {e.stage === 'done' && (
                      <span className="mt-0.5 block text-xs text-muted">
                        {statusLabel(e)}
                        {e.elapsedMs !== undefined ? ` — ${formatElapsed(e.elapsedMs)}` : ''}
                        {e.detail && e.status === 'repaired-missing'
                          ? ''
                          : e.detail && e.status !== 'skipped-good'
                            ? e.status === 'failed' || e.status === 'not-found'
                              ? ''
                              : ` (${e.detail})`
                            : ''}
                      </span>
                    )}
                    {e.stage === 'done' && (e.status === 'failed' || e.status === 'not-found') && e.detail && (
                      <span className="mt-0.5 block text-xs text-destructive">
                        Error: {e.detail}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
