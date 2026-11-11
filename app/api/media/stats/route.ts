import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { describeLiveRemuxJob, getLiveRemuxStats, getRemuxSlotStats, mediaTempMaxBytes, mediaTempUsage } from '@/lib/media/remux';
import { mediaCacheStats } from '@/lib/media/cache';

// Server-only diagnostics: node:fs + in-process registries.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Playback pipeline diagnostics (owner only).
 *
 * A safe, structured snapshot of the remux/cache machinery for the
 * observability requirement: NO MEGA credentials, session ids, keys, or
 * temporary download URLs are ever included — only internal video ids,
 * counts, byte totals, timings and memory gauges.
 *
 * GET /api/media/stats -> {
 *   memory: { rss, heapUsed, heapTotal, external, arrayBuffers } (bytes),
 *   remuxSlots: { active, max, queued },
 *   liveJobs: [{ videoId, ageMs, broadcastBytes, spoolBytes, subscribers,
 *                liveEnded, dying }],
 *   tempMedia: { bytes, files, maxBytes },
 *   cache: { dir, entries, entryBytes, staleEntries, staleBytes,
 *            tempBytes, tempFiles, maxBytes },
 * }
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const now = Date.now();
  const { active: liveJobCount, videoIds } = getLiveRemuxStats();
  const memory = process.memoryUsage();

  return NextResponse.json(
    {
      generatedAt: new Date().toISOString(),
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      remuxSlots: getRemuxSlotStats(),
      liveJobs: {
        count: liveJobCount,
        items: videoIds.map((id) => {
          const job = describeLiveRemuxJob(id, now);
          return job ?? { videoId: id, state: 'missing' };
        }),
      },
      tempMedia: {
        ...mediaTempUsage(),
        maxBytes: mediaTempMaxBytes(),
      },
      cache: await mediaCacheStats(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
