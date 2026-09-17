import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getMegaAccountForUser, markAccountReauthRequired } from '@/lib/megaAccounts';
import {
  findDuplicateGroups,
  findGroupsWipedOut,
  type DuplicateCandidate,
} from '@/lib/duplicates';
import {
  classifyMegaError,
  MegaError,
  safeMegaErrorMessage,
} from '@/lib/mega/account';
import { deleteMegaNode, isNotFoundError } from '@/lib/mega/nodeOps';
import { withMegaSession, evictMegaSession } from '@/lib/sync/session-cache';
import { enqueueSync } from '@/lib/sync/queue';

const MAX_DELETE_NODES = 100;

function invalidAccountId(id: number): boolean {
  return !Number.isInteger(id) || id <= 0;
}

async function loadOwnedAccount(accountId: number, userId: string) {
  // Ownership-scoped: null both when missing AND when owned by someone else
  // (callers map that to 404 so existence is never leaked).
  return getMegaAccountForUser(accountId, userId);
}

async function candidatesForAccount(accountId: number): Promise<DuplicateCandidate[]> {
  // One query, minimal columns - no N+1, no thumbnails/blobs loaded.
  const rows = await prisma.video.findMany({
    where: { megaAccountId: accountId },
    select: {
      id: true,
      megaNodeId: true,
      megaFilename: true,
      parentNodeId: true,
      fileSize: true,
      duration: true,
      title: true,
      thumbnail: true,
      mimeType: true,
      megaModifiedAt: true,
      creator: { select: { name: true } },
      megaAccount: { select: { id: true, label: true } },
    },
  });
  return rows
    .filter((r) => r.megaNodeId !== null)
    .map((r) => ({
      videoId: r.id,
      nodeId: r.megaNodeId as string,
      name: r.megaFilename,
      parentNodeId: r.parentNodeId,
      size: r.fileSize === null ? null : Number(r.fileSize),
      duration: r.duration,
      title: r.title,
      creatorName: r.creator?.name ?? null,
      thumbnail: r.thumbnail,
      mimeType: r.mimeType,
      megaModifiedAt: r.megaModifiedAt ? r.megaModifiedAt.toISOString() : null,
      accountId: r.megaAccount?.id ?? accountId,
      accountLabel: r.megaAccount?.label ?? null,
    }));
}

/**
 * Scan one MEGA account for possible duplicate videos (owner only).
 *
 * Transient computation over existing Video rows - nothing is persisted and
 * MEGA is never contacted. Groups are duplicate CANDIDATES (normalized title
 * similarity + exact size equality), never proven identical: the UI labels
 * them "Possible duplicates" and the user decides what to delete.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const id = Number((await params).id);
    if (invalidAccountId(id)) {
      return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 });
    }

    const account = await loadOwnedAccount(id, user.id);
    if (!account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    const result = findDuplicateGroups(await candidatesForAccount(id));
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

interface DeleteBody {
  nodeIds?: unknown;
}

function parseNodeIds(body: DeleteBody): { ok: true; nodeIds: string[] } | { ok: false; error: string } {
  if (!body || !Array.isArray(body.nodeIds)) {
    return { ok: false, error: 'Select at least one file to delete.' };
  }
  if (body.nodeIds.length === 0) {
    return { ok: false, error: 'Select at least one file to delete.' };
  }
  if (body.nodeIds.length > MAX_DELETE_NODES) {
    return { ok: false, error: `Delete at most ${MAX_DELETE_NODES} files at a time.` };
  }
  const seen = new Set<string>();
  for (const n of body.nodeIds) {
    if (typeof n !== 'string' || n.length === 0 || n.length > 64) {
      return { ok: false, error: 'Invalid file selection.' };
    }
    seen.add(n);
  }
  return { ok: true, nodeIds: [...seen] };
}

/** Outcome of one accepted node deletion (shared MEGA `a=d` op, see lib/mega/nodeOps). */
interface DeleteOutcome {
  nodeId: string;
  videoId: number;
  alreadyGone: boolean;
}

interface DeleteFailure {
  nodeId: string;
  videoId: number | null;
  reason: string;
}

/**
 * Delete explicitly selected duplicate candidates from MEGA (owner only).
 *
 * Server-side authority: every node id is re-verified against the owned
 * account's Video rows; unknown/foreign ids are rejected per-node. Requests
 * that would wipe out EVERY copy of any detected group are refused outright
 * (at least one copy must survive) - heuristic detection never weakens this
 * guard. Successful deletions trigger the existing account sync so the
 * database reconciles from MEGA.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const id = Number((await params).id);
    if (invalidAccountId(id)) {
      return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 });
    }

    const account = await loadOwnedAccount(id, user.id);
    if (!account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }
    if (!account.encryptedSession) {
      return NextResponse.json(
        { error: 'Your MEGA session needs to be reconnected.' },
        { status: 409 },
      );
    }

    const body = (await request.json().catch(() => null)) as DeleteBody | null;
    const parsed = parseNodeIds(body ?? {});
    if (parsed.ok === false) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const requested = new Set(parsed.nodeIds);

    // Re-verify every node against THIS account's rows (never trust client).
    const rows = await prisma.video.findMany({
      where: { megaAccountId: id, megaNodeId: { in: parsed.nodeIds } },
      select: { id: true, megaNodeId: true, megaFilename: true },
    });
    const byNode = new Map(rows.map((r) => [r.megaNodeId as string, r]));

    const failures: DeleteFailure[] = [];
    for (const nodeId of parsed.nodeIds) {
      if (!byNode.has(nodeId)) {
        // Unknown, already-synced-away, or another account's node: identical
        // response, no existence signal.
        failures.push({ nodeId, videoId: null, reason: 'not-found' });
      }
    }
    if (failures.length > 0) {
      return NextResponse.json(
        { error: 'Some selected files no longer exist. Rescan and try again.', deleted: [], failed: failures, syncQueued: false },
        { status: 404 },
      );
    }

    // Refuse to wipe out an entire detected group (must keep >= 1 copy).
    const current = findDuplicateGroups(await candidatesForAccount(id));
    const wiped = findGroupsWipedOut(current.groups, requested);
    if (wiped.length > 0) {
      return NextResponse.json(
        { error: 'Refusing to delete every copy of a duplicate set. Keep at least one copy in each group.' },
        { status: 422 },
      );
    }

    const targets = [...byNode.values()];
    const deleted: DeleteOutcome[] = [];
    const deleteFailures: DeleteFailure[] = [];
    let sessionDead = false;

    try {
      await withMegaSession(id, account.encryptedSession, async (storage) => {
        for (const t of targets) {
          const nodeId = t.megaNodeId as string;
          try {
            // Permanent delete via the shared node op (a=d): moves nothing
            // to rubbish - the bytes are freed, which is the point of this
            // feature. The user confirmed each node explicitly in the dialog.
            await deleteMegaNode(storage, nodeId);
            deleted.push({ nodeId, videoId: t.id, alreadyGone: false });
          } catch (err) {
            if (isNotFoundError(err)) {
              // Deleted externally (or twice from two tabs) - the next sync
              // removes the row; report honestly, not as a failure.
              deleted.push({ nodeId, videoId: t.id, alreadyGone: true });
              continue;
            }
            const kind = classifyMegaError(err, 'session');
            if (kind === 'session-expired' || kind === 'auth' || kind === 'mfa') {
              sessionDead = true;
              deleteFailures.push({ nodeId, videoId: t.id, reason: 'session-expired' });
              break;
            }
            deleteFailures.push({
              nodeId,
              videoId: t.id,
              reason: kind === 'transient' ? 'transient' : 'failed',
            });
          }
        }
      });
    } catch (err) {
      if (err instanceof MegaError) {
        const msg = safeMegaErrorMessage(err.kind);
        if (err.kind === 'session-expired' || err.kind === 'auth' || err.kind === 'mfa') {
          evictMegaSession(id);
          await markAccountReauthRequired(id, msg);
          return NextResponse.json(
            { error: 'Your MEGA session needs to be reconnected.', deleted, failed: deleteFailures, syncQueued: false },
            { status: 409 },
          );
        }
        return NextResponse.json(
          { error: msg, deleted, failed: deleteFailures, syncQueued: false },
          { status: 502 },
        );
      }
      return NextResponse.json(
        { error: 'Something went wrong.', deleted, failed: deleteFailures, syncQueued: false },
        { status: 500 },
      );
    }

    if (sessionDead) {
      evictMegaSession(id);
      await markAccountReauthRequired(id, safeMegaErrorMessage('session-expired'));
      // Nodes after the break were never attempted - mark them explicitly.
      const attempted = new Set([...deleted, ...deleteFailures].map((d) => d.nodeId));
      for (const t of targets) {
        const nodeId = t.megaNodeId as string;
        if (!attempted.has(nodeId)) {
          deleteFailures.push({ nodeId, videoId: t.id, reason: 'session-expired' });
        }
      }
      return NextResponse.json(
        { error: 'Your MEGA session needs to be reconnected.', deleted, failed: deleteFailures, syncQueued: false },
        { status: 409 },
      );
    }

    // Reconcile via the EXISTING sync engine (MEGA stays source of truth;
    // rows are removed by reconciliation, never by this handler directly).
    let syncQueued = false;
    if (deleted.length > 0) {
      try {
        const outcome = await enqueueSync(id, 'duplicates-delete');
        syncQueued = outcome === 'queued' || outcome === 'already-pending';
      } catch {
        syncQueued = false;
      }
    }

    return NextResponse.json({ deleted, failed: deleteFailures, syncQueued });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
