import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import {
  REPAIR_BATCH_LIMIT,
  endRepair,
  repairUserThumbnails,
  tryBeginRepair,
  type RepairEvent,
  type RepairSummary,
} from '@/lib/thumbs/repair';

export const dynamic = 'force-dynamic';

/**
 * Owner-scoped thumbnail repair: replaces missing/black/broken thumbnails
 * with real frames extracted from the user's own videos. Sequential,
 * safe to re-run. A second call while one is running gets 429 - expensive
 * generation is never parallelized per user, and no endpoint allows
 * touching another user's videos. The slot is shared with the post-sync
 * background repair (same mutex in lib/thumbs/repair).
 *
 * Progress is streamed as newline-delimited JSON (one object per line)
 * so the UI shows a live per-video log while real extraction happens:
 *   {"type":"started","total":123}
 *   {"type":"video-start","videoId":1,"title":"...","index":1,"total":123}
 *   {"type":"video-phase","videoId":1,"phase":"repairing","category":"repaired-problematic",...}
 *   {"type":"video-phase","videoId":1,"phase":"extracting",...}
 *   {"type":"video-done","videoId":1,"status":"repaired-problematic","elapsedMs":7800,...}
 *   {"type":"summary","summary":{...}}
 * Pass {"stream":false} to get the plain JSON summary instead (one-shot).
 */

type StreamLine =
  | ({ type: 'started'; total: number } & Record<string, unknown>)
  | (RepairEvent & { type: 'video-start' | 'video-phase' | 'video-done' })
  | { type: 'summary'; summary: RepairSummary };

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const owner = `user:${user.id}`;
    if (!tryBeginRepair(owner)) {
      return NextResponse.json({ error: 'A thumbnail repair is already running.' }, { status: 429 });
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const rawIds = Array.isArray(body?.videoIds) ? body.videoIds : undefined;
    const videoIds =
      rawIds === undefined
        ? undefined
        : rawIds.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0).slice(0, REPAIR_BATCH_LIMIT);
    const rawLimit = typeof body?.limit === 'number' ? body.limit : undefined;
    const limit =
      rawLimit === undefined
        ? undefined
        : Math.max(1, Math.min(Math.floor(rawLimit), REPAIR_BATCH_LIMIT));
    const stream = body?.stream !== false;

    if (!stream) {
      try {
        const summary = await repairUserThumbnails(user.id, { videoIds, limit });
        return NextResponse.json(summary);
      } finally {
        endRepair(owner);
      }
    }

    const encoder = new TextEncoder();
    let closed = false;
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: StreamLine) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            closed = true;
          }
        };
        const onAbort = () => {
          closed = true;
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        try {
          // started/total is sent once the run begins; per-video events
          // carry index/total so the client can render progress live.
          let startedSent = false;
          const summary = await repairUserThumbnails(user.id, {
            videoIds,
            limit,
            onEvent: (e) => {
              if (e.type === 'video-start' && !startedSent && typeof e.total === 'number') {
                startedSent = true;
                send({ type: 'started', total: e.total } as StreamLine);
              }
              send(e as StreamLine);
            },
          });
          if (!startedSent) send({ type: 'started', total: summary.scanned } as StreamLine);
          send({ type: 'summary', summary });
        } catch {
          if (!closed) {
            try {
              controller.enqueue(
                encoder.encode(`${JSON.stringify({ type: 'error', error: 'Something went wrong.' })}\n`),
              );
            } catch {
              // client gone
            }
          }
        } finally {
          request.signal.removeEventListener('abort', onAbort);
          endRepair(owner);
          if (!closed) {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
