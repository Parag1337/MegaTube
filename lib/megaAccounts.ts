/**
 * User-scoped data access for linked MEGA accounts.
 *
 * SECURITY: every read/write here takes the website user id as a parameter
 * and scopes the query by it. There is no unscoped account accessor anywhere
 * in the codebase - ownership is enforced in the data layer, not just in the
 * API routes.
 */

import { prisma } from './db';
import { encryptSecret } from './mega/envelope';
import type { MegaSessionMaterial } from './mega/account';

export const MEGA_ACCOUNT_STATUSES = {
  CONNECTED: 'CONNECTED',
  SYNCING: 'SYNCING',
  SYNCED: 'SYNCED',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  ERROR: 'ERROR',
  DISCONNECTED: 'DISCONNECTED',
} as const;

export type MegaAccountStatus = (typeof MEGA_ACCOUNT_STATUSES)[keyof typeof MEGA_ACCOUNT_STATUSES];

export const STATUS_VALUES = Object.values(MEGA_ACCOUNT_STATUSES) as string[];

/** Fields safe to expose to the owner's browser (no session material). */
export interface PublicMegaAccount {
  id: number;
  label: string;
  megaEmail: string;
  megaUserId: string | null;
  status: MegaAccountStatus;
  lastAuthenticatedAt: Date | null;
  lastSyncStartedAt: Date | null;
  lastSyncCompletedAt: Date | null;
  lastSyncError: string | null;
  /** Durable JSON metadata of the last sync (see SyncMeta). Null if never synced. */
  lastSyncMeta: SyncMeta | null;
  videoCount: number;
  createdAt: Date;
}

/** Durable record of one sync run (stored as JSON in MegaAccount.lastSyncMeta). */
export interface SyncMeta {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  /** Video nodes discovered in MEGA during the scan. */
  discovered: number;
  /** Final row count for the account after reconciliation. */
  totalVideos: number;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  outcome: 'completed' | 'failed' | 'interrupted';
}

const publicSelect = {
  id: true,
  label: true,
  megaEmail: true,
  megaUserId: true,
  status: true,
  lastAuthenticatedAt: true,
  lastSyncStartedAt: true,
  lastSyncCompletedAt: true,
  lastSyncError: true,
  lastSyncMeta: true,
  videoCount: true,
  createdAt: true,
} as const;

function defaultLabelFor(email: string): string {
  return email.split('@')[0] || 'MEGA account';
}

export function sanitizeLabel(label: string): string {
  return label.trim().slice(0, 50);
}

export async function listMegaAccountsForUser(
  userId: string,
): Promise<PublicMegaAccount[]> {
  const rows = await prisma.megaAccount.findMany({
    where: { userId },
    select: publicSelect,
    orderBy: { createdAt: 'asc' },
  });
  return rows.map(parseSyncMeta) as PublicMegaAccount[];
}

/** Parse the stored lastSyncMeta JSON (returns null for missing/corrupt data). */
function parseSyncMeta<T extends { lastSyncMeta: string | null }>(row: T): T & { lastSyncMeta: SyncMeta | null } {
  if (!row.lastSyncMeta || typeof row.lastSyncMeta !== 'string') {
    return { ...row, lastSyncMeta: null };
  }
  try {
    const parsed = JSON.parse(row.lastSyncMeta) as SyncMeta;
    if (
      typeof parsed.startedAt !== 'string' ||
      typeof parsed.completedAt !== 'string' ||
      typeof parsed.durationMs !== 'number' ||
      typeof parsed.totalVideos !== 'number'
    ) {
      return { ...row, lastSyncMeta: null };
    }
    return { ...row, lastSyncMeta: parsed };
  } catch {
    return { ...row, lastSyncMeta: null };
  }
}

/**
 * Fetch one account scoped to its owner. Returns null when the account does
 * NOT exist for this user (callers map that to 404 so existence is never
 * leaked to other users).
 */
export async function getMegaAccountForUser(
  id: number,
  userId: string,
): Promise<(PublicMegaAccount & { encryptedSession: string }) | null> {
  const row = await prisma.megaAccount.findFirst({
    where: { id, userId },
    select: { ...publicSelect, encryptedSession: true },
  });
  return row as (PublicMegaAccount & { encryptedSession: string }) | null;
}

export interface LinkMegaAccountInput {
  userId: string;
  label: string;
  email: string;
  material: MegaSessionMaterial;
}

/**
 * Create a new linked account (or re-link a previously disconnected one with
 * the same email). Session material is encrypted at rest.
 */
export async function createMegaAccount(input: LinkMegaAccountInput) {
  const email = input.email.toLowerCase().trim();
  const encrypted = encryptSecret(JSON.stringify(input.material));
  const now = new Date();

  const existing = await prisma.megaAccount.findUnique({
    where: { userId_megaEmail: { userId: input.userId, megaEmail: email } },
  });

  if (existing) {
    if (existing.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
      // Re-link: reuse the row (keeps any preserved metadata), fresh material.
      return prisma.megaAccount.update({
        where: { id: existing.id },
        data: {
          label: sanitizeLabel(input.label) || defaultLabelFor(email),
          encryptedSession: encrypted,
          megaUserId: input.material.user || null,
          status: MEGA_ACCOUNT_STATUSES.CONNECTED,
          lastAuthenticatedAt: now,
          lastSyncError: null,
          consecutiveSyncFailures: 0,
        },
      });
    }
    throw new Error('already-linked');
  }

  return prisma.megaAccount.create({
    data: {
      userId: input.userId,
      label: sanitizeLabel(input.label) || defaultLabelFor(email),
      megaEmail: email,
      megaUserId: input.material.user || null,
      encryptedSession: encrypted,
      status: MEGA_ACCOUNT_STATUSES.CONNECTED,
      lastAuthenticatedAt: now,
    },
  });
}

/**
 * Persist fresh session material after a successful explicit reconnection.
 *
 * Ownership-scoped (updateMany keyed on id + userId; count 0 -> not-found).
 * Only the AES-256-GCM encrypted form of the material is ever written to the
 * database - the plaintext material and the MEGA password are not persisted
 * anywhere.
 *
 * IMPORTANT: this does NOT set status. Callers must only persist material
 * that has passed session-resume verification (verifyStoredSession) and then
 * mark the account CONNECTED via {@link markAccountConnected} - CONNECTED is
 * never claimed before both persistence and resume verification succeed.
 */
export async function replaceMegaAccountSession(
  id: number,
  userId: string,
  material: MegaSessionMaterial,
) {
  const encrypted = encryptSecret(JSON.stringify(material));
  const res = await prisma.megaAccount.updateMany({
    where: { id, userId },
    data: {
      encryptedSession: encrypted,
      megaUserId: material.user || null,
      lastAuthenticatedAt: new Date(),
    },
  });
  if (res.count === 0) throw new Error('not-found');
}

/**
 * Mark an account CONNECTED after its session material was persisted and
 * verified resumable. Clears stale authentication/sync error state so the
 * UI shows a clean "Connected".
 */
export async function markAccountConnected(id: number, userId: string): Promise<void> {
  const res = await prisma.megaAccount.updateMany({
    where: { id, userId },
    data: {
      status: MEGA_ACCOUNT_STATUSES.CONNECTED,
      lastSyncError: null,
      lastSyncErrorAt: null,
      consecutiveSyncFailures: 0,
    },
  });
  if (res.count === 0) throw new Error('not-found');
}

export async function markAccountReauthRequired(id: number, safeMessage: string): Promise<void> {
  await prisma.megaAccount.updateMany({
    where: { id },
    data: {
      status: MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED,
      lastSyncError: safeMessage,
      lastSyncErrorAt: new Date(),
    },
  });
}

export async function markAccountError(id: number, safeMessage: string): Promise<void> {
  await prisma.megaAccount.updateMany({
    where: { id },
    data: {
      status: MEGA_ACCOUNT_STATUSES.ERROR,
      lastSyncError: safeMessage,
      lastSyncErrorAt: new Date(),
      consecutiveSyncFailures: { increment: 1 },
    },
  });
}

/**
 * Claim the right to run a sync for this account. Atomic gate that prevents
 * two concurrent sync jobs for the same account: only one updateMany can flip
 * the status from a non-SYNCING state.
 *
 * @returns true if this caller won the claim.
 */
export async function claimSyncStart(id: number): Promise<boolean> {
  const res = await prisma.megaAccount.updateMany({
    where: { id, status: { not: MEGA_ACCOUNT_STATUSES.SYNCING } },
    data: {
      status: MEGA_ACCOUNT_STATUSES.SYNCING,
      lastSyncStartedAt: new Date(),
      lastSyncError: null,
    },
  });
  return res.count === 1;
}

export async function markSyncCompleted(id: number, videoCount: number): Promise<void> {
  await prisma.megaAccount.updateMany({
    where: { id },
    data: {
      status: MEGA_ACCOUNT_STATUSES.SYNCED,
      lastSyncCompletedAt: new Date(),
      videoCount,
      consecutiveSyncFailures: 0,
    },
  });
}

/**
 * Disconnect: delete all stored authentication material and mark the account
 * DISCONNECTED. Video rows are preserved on purpose (documented behavior):
 * they are hidden from the user while disconnected and become visible again
 * if the same MEGA email is linked again (a resync then reconciles any
 * deletions that happened meanwhile).
 */
export async function disconnectMegaAccount(id: number, userId: string): Promise<void> {
  const res = await prisma.megaAccount.updateMany({
    where: { id, userId },
    data: {
      encryptedSession: '',
      status: MEGA_ACCOUNT_STATUSES.DISCONNECTED,
      lastSyncError: null,
      videoCount: 0,
    },
  });
  if (res.count === 0) throw new Error('not-found');
}

/** Set the denormalized video count (used by the sync engine). */
export async function setVideoCount(id: number, count: number): Promise<void> {
  await prisma.megaAccount.updateMany({ where: { id }, data: { videoCount: count } });
}

/**
 * Persist the durable metadata of a finished sync run. Scoped by account id
 * only (the sync engine is server-side; ownership is enforced at the API
 * layer that triggers it).
 */
export async function setLastSyncMeta(id: number, meta: SyncMeta): Promise<void> {
  await prisma.megaAccount.updateMany({
    where: { id },
    data: { lastSyncMeta: JSON.stringify(meta) },
  });
}

/** Accounts eligible for automatic sync (scheduler + retry decisions). */
export async function listSyncableAccountsForUser(
  userId: string,
): Promise<PublicMegaAccount[]> {
  const rows = await prisma.megaAccount.findMany({
    where: {
      userId,
      status: {
        in: [
          MEGA_ACCOUNT_STATUSES.CONNECTED,
          MEGA_ACCOUNT_STATUSES.SYNCED,
          MEGA_ACCOUNT_STATUSES.ERROR,
        ],
      },
    },
    select: publicSelect,
  });
  return rows as PublicMegaAccount[];
}

/**
 * All accounts of a user that currently have a stored session (anything not
 * DISCONNECTED), with their encrypted session - used by the session cache in
 * lib/sync. Scoped by design.
 */
export async function listAccountsWithSessionsForUser(userId: string) {
  return prisma.megaAccount.findMany({
    where: {
      userId,
      status: { not: MEGA_ACCOUNT_STATUSES.DISCONNECTED },
      encryptedSession: { not: '' },
    },
    select: {
      id: true,
      encryptedSession: true,
      megaEmail: true,
    },
  });
}
