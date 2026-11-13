/**
 * Next.js instrumentation hook (runs once per server instance, before the
 * server accepts requests).
 *
 * RUNTIME BOUNDARY (important):
 * This file is evaluated in BOTH the Node.js and Edge runtimes. The
 * Node-only DNS/network configuration in lib/net-resilience.ts imports
 * node:dns and node:net, which do not exist in Edge. Per Next.js's
 * documented pattern, we gate on process.env.NEXT_RUNTIME with a
 * conditional require() so the Node-only module is NEVER bundled into (or
 * executed by) the Edge runtime - instead of importing it unconditionally
 * and silencing errors.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Conditional require: keeps node:dns/node:net out of Edge bundles.
    // This is the exact pattern from the Next.js instrumentation docs
    // (static import() would pull the module into BOTH runtime bundles).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/net-resilience').applyNetworkResilience();
    // Credential-free DB identity. Every web/worker process logs the same
    // fingerprint when it shares DATABASE_URL; a mismatch is visible in the
    // platform logs without ever printing a connection string or password.
    await import('./lib/db')
      .then((m) => {
        console.log(`[db] identity ${m.databaseIdentityFingerprint()} (credential-free host/port/database fingerprint)`);
      })
      .catch(() => {});
    // Bug 6: temp files from jobs killed by a crash/hard exit (*.ts.part,
    // *.part.mp4, *.live.spool) can never clean themselves up. Sweep them
    // once per server start, before any media request can create a new job,
    // so this cannot race a live job's own cleanup. Successful caches are
    // never touched.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/media/remux')
      .cleanupOrphanedTempFiles()
      .catch(() => {});
    // P1.5: background media-cache eviction (size cap + LRU). Interval-based
    // and deferred past startup - never in the playback startup path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/media/cache').startMediaCacheMaintenance();
    // Phase 5 (additive): preview-store LRU eviction + orphan temp-dir sweep
    // (`<id>.tmp-*/` from crashed generation jobs). Same deferred pattern;
    // never touches the media cache directory.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/preview/cache').startPreviewMaintenance();
    // P-02: reclaim old failed/unpublished artifacts once per start, before
    // the worker can create new work. Grace-based and safe alongside another
    // live instance's jobs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/preview/cache').cleanupFailedPreviewArtifacts().catch(() => {});
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/preview/source').sweepOrphanWorkDirs().catch(() => {});
    // Phase 5.1: resume the durable preview backlog. One guarded worker loop
    // per Node server; claims jobs with SKIP LOCKED so multiple instances
    // never generate the same preview twice. Never starts during a build.
    // Dynamic import (not require): Turbopack's instrumentation CJS interop
    // does not expose this module's named exports through require().
    await import('./lib/preview/worker')
      .then((m) => m.startPreviewWorker())
      .catch(() => {});
  }
}
