'use client';

/**
 * Owner-scoped thumbnail repair trigger. One bounded repair run at a time
 * (the API answers 429 while a run is in flight).
 *
 * The repair endpoint streams newline-delimited JSON progress while real
 * extraction happens, so this renders a live per-video log:
 * good thumbnails show "Looks good — skipped" (no extraction ran for
 * them), repairs show Repairing... -> Extracting frame... -> success or
 * failure with per-video timing, and a totals summary at the end.
 */

import { useRef, useState } from 'react';

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
  if (ms === undefined || ms === null) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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

export function RepairThumbsButton() {
  const [running, setRunning] = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [summary, setSummary] = useState<RepairCounts | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const logRef = useRef<HTMLDivElement>(null);

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
    try {
      const res = await fetch('/api/thumbs/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 429) throw new Error('A repair is already running - try again in a bit.');
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((data as { error?: string } | null)?.error || 'Repair failed.');
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('ndjson') || !res.body) {
        // One-shot fallback: plain JSON summary.
        const data = (await res.json().catch(() => null)) as RepairCounts | null;
        if (!data) throw new Error('Repair failed.');
        setSummary(data);
        setDone(true);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const pump = async (): Promise<void> => {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) {
          if (buf.trim().length > 0) handleLine(buf);
          return;
        }
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.length > 0) handleLine(line);
        }
        await pump();
      };
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
      await pump();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRunning(false);
      queueMicrotask(scrollToBottom);
    }
  }

  const showLog = running || entries.length > 0;

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
        {running && total !== null && (
          <p className="text-[13px] text-muted" role="status">
            Repairing thumbnails… ({entries.filter((e) => e.stage === 'done').length}/{total})
          </p>
        )}
      </div>

      {showLog && (
        <div
          ref={logRef}
          aria-live="polite"
          className="mt-3 max-h-80 overflow-y-auto rounded-xl border border-border bg-surface-raised p-3 text-[13px] leading-6"
        >
          {entries.map((e) => (
            <div key={e.videoId} className="mb-2 last:mb-0">
              <div className="flex items-baseline gap-2">
                <span aria-hidden>
                  {e.stage === 'done' ? (e.status === 'skipped-good' ? '✓' : e.status === 'failed' || e.status === 'not-found' ? '✗' : '✓') : '●'}
                </span>
                <span className="font-medium">{e.title}</span>
              </div>
              {e.stage === 'start' && <div className="pl-5 text-muted">Classifying…</div>}
              {(e.stage === 'repairing' || e.stage === 'extracting') && (
                <div className="pl-5 text-muted">
                  <div>{e.category ? categoryLabel(e.category) : 'Repairing'}</div>
                  <div>↳ Repairing…</div>
                  {e.stage === 'extracting' && <div>↳ Extracting frame…</div>}
                </div>
              )}
              {e.stage === 'done' && (
                <div className="pl-5 text-muted">
                  {e.status !== 'skipped-good' &&
                    e.status !== 'failed' &&
                    e.status !== 'not-found' &&
                    e.status !== 'skipped-cap' && (
                      <div>{categoryLabel((e.category ?? e.status ?? 'repaired') as RepairStatus)}</div>
                    )}
                  <div>
                    {statusLabel(e)}
                    {e.elapsedMs !== undefined && e.status !== undefined ? ` — ${formatElapsed(e.elapsedMs)}` : ''}
                  </div>
                </div>
              )}
            </div>
          ))}
          {done && summary && (
            <div className="mt-3 border-t border-border pt-2 font-medium">
              <div>Repair complete</div>
              <div className="font-normal text-muted">
                ✓ Good thumbnails skipped: {summary.skippedGood}
                <br />✓ Black thumbnails repaired: {summary.repairedBlack}
                <br />✓ Missing thumbnails repaired: {summary.repairedMissing}
                <br />✓ Previously problematic videos repaired: {summary.repairedProblematic}
                <br />⚠ Still unavailable: {summary.notFound}
                <br />✗ Failed: {summary.failed}
              </div>
            </div>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-2 text-[13px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
