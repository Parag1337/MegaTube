/**
 * Pure sync reconciliation: compare what MEGA reports (remote) against what
 * we have stored (existing rows) and plan the database operations.
 *
 * Identity = MEGA node handle (megaNodeId), which is stable across renames,
 * moves and re-uploads... with one caveat: MEGA re-upload creates a NEW node
 * handle, so a "replaced" file shows up as one deletion + one addition. That
 * is the correct, safe behavior.
 *
 * This module has no I/O and no MEGA dependency: it is fully unit-testable.
 */

/** A video node as discovered in MEGA (already filtered to videos). */
export interface RemoteVideoNode {
  nodeId: string;
  parentNodeId: string | null;
  name: string | null;
  size: number;
  /** MEGA node timestamp (unix seconds), if known. */
  ts: number | null;
  fa: string | null;
  /** 32-byte file key, if it could be derived. */
  fileKey: Buffer | null;
}

/** The stored subset of a Video row relevant to reconciliation. */
export interface ExistingVideoRow {
  id: number;
  megaNodeId: string;
  megaFilename: string;
  fileSize: bigint;
  parentNodeId: string | null;
  /** MEGA node timestamp stored as ms since epoch (or null). */
  megaModifiedAt: Date | null;
  megaFa: string;
  thumbnailAvailable: boolean;
  thumbnail: string;
  creatorId: number | null;
  /** Whether the creator assignment is protected from automatic sync. */
  creatorAssignment: string;
}

export interface ReconcilePlan {
  /** Nodes in MEGA with no local row -> create. */
  toAdd: RemoteVideoNode[];
  /** Local rows whose metadata differs from MEGA -> update. */
  toUpdate: Array<{
    row: ExistingVideoRow;
    remote: RemoteVideoNode;
    changes: string[];
  }>;
  /** Local rows no longer present in MEGA -> delete. */
  toRemove: ExistingVideoRow[];
  /** Local rows identical to MEGA -> untouched (no writes, no reprocessing). */
  unchanged: ExistingVideoRow[];
}

function sameSize(a: bigint | null, b: number): boolean {
  return (a ?? BigInt(-1)) === BigInt(b);
}

function sameTs(a: Date | null, b: number | null): boolean {
  const av = a ? Math.floor(a.getTime() / 1000) : null;
  return av === b;
}

export function planReconciliation(
  remote: RemoteVideoNode[],
  existing: ExistingVideoRow[],
): ReconcilePlan {
  const plan: ReconcilePlan = { toAdd: [], toUpdate: [], toRemove: [], unchanged: [] };
  const existingByNode = new Map(existing.map((r) => [r.megaNodeId, r]));
  const remoteByNode = new Map(remote.map((r) => [r.nodeId, r]));

  for (const r of remote) {
    const row = existingByNode.get(r.nodeId);
    if (!row) {
      plan.toAdd.push(r);
      continue;
    }
    const changes: string[] = [];
    const remoteName = r.name ?? '';
    if (row.megaFilename !== remoteName) changes.push('rename');
    if (!sameSize(row.fileSize, r.size)) changes.push('size');
    if (!sameTs(row.megaModifiedAt, r.ts)) changes.push('timestamp');
    if ((row.parentNodeId ?? null) !== (r.parentNodeId ?? null)) changes.push('move');
    if ((row.megaFa ?? null) !== (r.fa ?? null)) changes.push('file-attributes');

    if (changes.length === 0) {
      plan.unchanged.push(row);
    } else {
      plan.toUpdate.push({ row, remote: r, changes });
    }
  }

  for (const row of existing) {
    if (!remoteByNode.has(row.megaNodeId)) {
      plan.toRemove.push(row);
    }
  }

  return plan;
}
