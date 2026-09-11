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
    // Bug 6: temp files from jobs killed by a crash/hard exit (*.ts.part,
    // *.part.mp4, *.live.spool) can never clean themselves up. Sweep them
    // once per server start, before any media request can create a new job,
    // so this cannot race a live job's own cleanup. Successful caches are
    // never touched.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./lib/media/remux')
      .cleanupOrphanedTempFiles()
      .catch(() => {});
  }
}
