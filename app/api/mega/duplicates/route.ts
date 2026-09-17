import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  getMegaAccountForUser,
  listMegaAccountsForUser,
  markAccountReauthRequired,
  MEGA_ACCOUNT_STATUSES,
} from '@/lib/megaAccounts';
import {
  findDuplicateGroups,
  findGroupsWipedOut,
  partitionDeletionTargets,
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

interface ScopeAccount {
  id: number;
  label: string;
  videoCount: number;
}

/**
 * Resolve the scan scope: 'all' = every owned, non-disconnected MegaAccount;
 * a numeric id = that single account when owned by the caller.
 * Returns null when a numeric id is not owned (mapped to 404, no leak).
 */
async function resolveScopeAccounts(
  userId: string,
  accountId: string | null,
): Promise<{ scope: 'all' | number; accounts: ScopeAccount[] } | null> {
  if (accountId !== null && accountId !== 'all') {
    const id = Number(accountId);
    if (invalidAccountId(id)) return null;
    const account = await getMegaAccountForUser(id, userId);
    if (!account) return null;
    return {
      scope: id,
      accounts:
        account.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED
          ? []
          : [{ id, label: account.label, videoCount: account.videoCount }],
    };
  }
  const all = await listMegaAccountsForUser(userId);
  return {
    scope: 'all',
    accounts: all
      .filter((a) => a.status !== MEGA_ACCOUNT_STATUSES.DISCONNECTED)
      .map((a) => ({ id: a.id, label: a.label, videoCount: a.videoCount })),
  };
}

async function candidatesForAccounts(accountIds: number[]): Promise<DuplicateCandidate[]> {
  if (accountIds.length === 0) return [];
  // One query across the scope - no N+1. Only pre-stored columns are read:
  // thumbnails below are presentation-only references, never generated here,
  // and video bytes are never touched.
  const rows = await prisma.video.findMany({
    where: { megaAccountId: { in: accountIds } },
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
      accountId: r.megaAccount?.id ?? null,
      accountLabel: r.megaAccount?.label ?? null,
    }));
}

/**
 * Scan duplicate candidates across one account or all of the caller's
 * accounts (owner only, `?accountId=all|<id>`, default `all`).
 *
 * Detection pools every candidate in the scope, so copies living in
 * different MEGA accounts form ONE cross-account group carrying each copy's
 * account label. Transient computation over existing Video rows - nothing is
 * persisted, MEGA is never contacted, thumbnails are never generated.
 */
export async function GET(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const accountParam = new URL(request.url).searchParams.get('accountId') ?? 'all';
    const resolved = await resolveScopeAccounts(user.id, accountParam);
    if (!resolved) {
      const id = Number(accountParam);
      if (accountParam !== 'all' && invalidAccountId(id)) {
        return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 });
      }
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    const result = findDuplicateGroups(
      await candidatesForAccounts(resolved.accounts.map((a) => a.id)),
    );
    return NextResponse.json({ ...result, scope: resolved.scope, accounts: resolved.accounts });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Cross-account deletion
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
  accountId: number;
  accountLabel: string | null;
  alreadyGone: boolean;
}

interface DeleteFailure {
  nodeId: string;
  videoId: number | null;
  accountId: number | null;
  reason: string;
}

/**
 * Delete explicitly selected nodes across the caller's accounts.
 *
 * Authorization (browser ids are never trusted):
 *   1. Clerk user -> application user (getCurrentUser).
 *   2. Every node id must resolve to a Video row in an account OWNED BY that
 *      user (`megaAccount: { userId }` in the query) - foreign/unknown ids
 *      are indistinguishable `not-found` rejections.
 *   3. The keep-one-copy guard runs over groups pooled across ALL involved
 *      accounts, so a cross-account group can never be wiped out piecemeal.
 *   4. Only explicitly selected nodes are deleted, each through its OWN
 *      account's session (per-account MEGA `a=d`), leaving other accounts
 *      untouched. Reconciliation uses the existing per-account sync.
 */
export async function DELETE(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const body = (await request.json().catch(() => null)) as DeleteBody | null;
    const parsed = parseNodeIds(body ?? {});
    if (parsed.ok === false) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const requested = new Set(parsed.nodeIds);

    // User-scoped by construction: rows outside the caller's accounts (or in
    // disconnected ones, whose videos are hidden by design) simply don't
    // match, and land in unknownNodeIds below.
    const rows = await prisma.video.findMany({
      where: {
        megaNodeId: { in: parsed.nodeIds },
        megaAccount: {
          userId: user.id,
          status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
        },
      },
      select: {
        id: true,
        megaNodeId: true,
        megaFilename: true,
        megaAccountId: true,
        megaAccount: {
          select: { id: true, label: true, encryptedSession: true },
        },
      },
    });

    const { byAccount, unknownNodeIds } = partitionDeletionTargets(
      rows.map((r) => ({
        nodeId: r.megaNodeId as string,
        videoId: r.id,
        megaAccountId: r.megaAccountId as number,
      })),
      parsed.nodeIds,
    );
    if (unknownNodeIds.length > 0) {
      return NextResponse.json(
        {
          error: 'Some selected files no longer exist. Rescan and try again.',
          deleted: [],
          failed: unknownNodeIds.map((nodeId) => ({ nodeId, videoId: null, accountId: null, reason: 'not-found' })),
          syncQueued: false,
        },
        { status: 404 },
      );
    }

    // Global wipe guard: groups pooled across every involved account, so
    // deleting "the rest" through separate per-account calls cannot slip
    // through - this single check sees the whole selection at once.
    const involvedIds = [...byAccount.keys()];
    const current = findDuplicateGroups(await candidatesForAccounts(involvedIds));
    const wiped = findGroupsWipedOut(current.groups, requested);
    if (wiped.length > 0) {
      return NextResponse.json(
        { error: 'Refusing to delete every copy of a duplicate set. Keep at least one copy in each group.' },
        { status: 422 },
      );
    }

    const accountMeta = new Map(
      rows.map((r) => [
        r.megaAccountId as number,
        { label: r.megaAccount?.label ?? null, encryptedSession: r.megaAccount?.encryptedSession ?? '' },
      ]),
    );

    const deleted: DeleteOutcome[] = [];
    const failures: DeleteFailure[] = [];
    const sessionDeadAccounts: number[] = [];

    for (const [accountId, targets] of byAccount) {
      const meta = accountMeta.get(accountId);
      if (!meta || !meta.encryptedSession) {
        for (const t of targets) {
          failures.push({ nodeId: t.nodeId, videoId: t.videoId, accountId, reason: 'session-expired' });
        }
        sessionDeadAccounts.push(accountId);
        continue;
      }
      try {
        await withMegaSession(accountId, meta.encryptedSession, async (storage) => {
          for (const t of targets) {
            try {
              // Permanent delete via the shared node op (a=d) through THIS
              // account's session only.
              await deleteMegaNode(storage, t.nodeId);
              deleted.push({ nodeId: t.nodeId, videoId: t.videoId, accountId, accountLabel: meta.label, alreadyGone: false });
            } catch (err) {
              if (isNotFoundError(err)) {
                deleted.push({ nodeId: t.nodeId, videoId: t.videoId, accountId, accountLabel: meta.label, alreadyGone: true });
                continue;
              }
              const kind = classifyMegaError(err, 'session');
              if (kind === 'session-expired' || kind === 'auth' || kind === 'mfa') {
                sessionDeadAccounts.push(accountId);
                failures.push({ nodeId: t.nodeId, videoId: t.videoId, accountId, reason: 'session-expired' });
                break;
              }
              failures.push({
                nodeId: t.nodeId,
                videoId: t.videoId,
                accountId,
                reason: kind === 'transient' ? 'transient' : 'failed',
              });
            }
          }
        });
      } catch (err) {
        if (err instanceof MegaError) {
          const msg = safeMegaErrorMessage(err.kind);
          if (err.kind === 'session-expired' || err.kind === 'auth' || err.kind === 'mfa') {
            evictMegaSession(accountId);
            await markAccountReauthRequired(accountId, msg);
            if (!sessionDeadAccounts.includes(accountId)) sessionDeadAccounts.push(accountId);
            const attempted = new Set([...deleted, ...failures].map((d) => d.nodeId));
            for (const t of targets) {
              if (!attempted.has(t.nodeId)) {
                failures.push({ nodeId: t.nodeId, videoId: t.videoId, accountId, reason: 'session-expired' });
              }
            }
            continue;
          }
          for (const t of targets) {
            if (![...deleted, ...failures].some((d) => d.nodeId === t.nodeId)) {
              failures.push({ nodeId: t.nodeId, videoId: t.videoId, accountId, reason: 'failed' });
            }
          }
          continue;
        }
        for (const t of targets) {
          if (![...deleted, ...failures].some((d) => d.nodeId === t.nodeId)) {
            failures.push({ nodeId: t.nodeId, videoId: t.videoId, accountId, reason: 'failed' });
          }
        }
      }
    }

    for (const accountId of sessionDeadAccounts) {
      evictMegaSession(accountId);
      await markAccountReauthRequired(accountId, safeMegaErrorMessage('session-expired'));
    }

    // Reconcile via the EXISTING sync engine, per affected account (MEGA
    // stays source of truth; rows are removed by reconciliation, never here).
    const syncedAccounts = new Set(deleted.map((d) => d.accountId));
    let syncQueued = false;
    for (const accountId of syncedAccounts) {
      try {
        const outcome = await enqueueSync(accountId, 'duplicates-delete');
        if (outcome === 'queued' || outcome === 'already-pending') syncQueued = true;
      } catch {
        // best-effort; the outcome already reports what MEGA did
      }
    }

    if (deleted.length === 0 && failures.length > 0 && failures.every((f) => f.reason === 'session-expired')) {
      return NextResponse.json(
        { error: 'Your MEGA session needs to be reconnected.', deleted, failed: failures, syncQueued: false },
        { status: 409 },
      );
    }

    return NextResponse.json({ deleted, failed: failures, syncQueued });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
