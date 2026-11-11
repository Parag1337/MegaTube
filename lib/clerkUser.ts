import { randomBytes } from 'crypto';
import { prisma } from './db';
import type { UserRecord } from './auth';
import { TtlMemo, authMemoTtlMs } from './user-memo';

// NOTE: @clerk/nextjs/server is imported lazily inside getCurrentMegaUser
// so that resolveMegaUserForClerk stays importable in plain unit tests
// (Clerk's server module requires the Next.js runtime).

const SELECT = { id: true, email: true, createdAt: true } as const;

/**
 * Clerk -> MegaTube user mapping.
 *
 * Architecture:
 *
 *   Clerk User -> Clerk userId -> MegaTube User (User.clerkUserId)
 *     -> all existing MegaTube data (still keyed by User.id)
 *
 * The internal User.id is NEVER replaced. Existing users are preserved by
 * linking on verified email (see resolveMegaUserForClerk).
 */

/** Normalize an email the same way the legacy password flow does. */
function normalizeClerkEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Resolve (linking or creating as needed) the MegaTube user for an
 * authenticated Clerk identity. Pure data function - exported for tests.
 *
 * 1. If a MegaTube user already carries this clerkUserId, return it.
 * 2. Else, if email matches exactly one existing MegaTube user (emails are
 *    UNIQUE) and that row is not linked to a DIFFERENT Clerk identity,
 *    attach this clerkUserId to it and return it - the returning user keeps
 *    every MEGA account, video, watchlist entry, folder, and history row.
 * 3. Else, if email matches a row linked to a different Clerk identity,
 *    return null (ambiguous - never steal or duplicate).
 * 4. Else, create a fresh MegaTube user for this Clerk identity. The
 *    passwordHash column is required, so Clerk-managed rows carry an
 *    unguessable sentinel that can never verify as a password.
 * 5. If neither a link nor an email is available, return null and let the
 *    caller treat the request as unauthenticated.
 */
export async function resolveMegaUserForClerk(
  clerkUserId: string,
  email: string | null,
): Promise<UserRecord | null> {
  const linked = await prisma.user.findUnique({
    where: { clerkUserId },
    select: SELECT,
  });
  if (linked) return linked;

  if (email) {
    const normalized = normalizeClerkEmail(email);
    const existing = await prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, email: true, createdAt: true, clerkUserId: true },
    });
    if (existing) {
      if (existing.clerkUserId && existing.clerkUserId !== clerkUserId) {
        console.warn(
          `[clerk] email ${normalized} already linked to a different Clerk identity; refusing to re-link`,
        );
        return null;
      }
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: { clerkUserId },
        select: SELECT,
      });
      return updated;
    }

    const created = await prisma.user.create({
      data: {
        email: normalized,
        passwordHash: `clerk-managed:${randomBytes(32).toString('hex')}`,
        clerkUserId,
      },
      select: SELECT,
    });
    return created;
  }

  console.warn('[clerk] authenticated Clerk user has no email; cannot map to a MegaTube user');
  return null;
}

/**
 * Server-side helper: return the MegaTube user for the current Clerk
 * session, or null when signed out / unmappable.
 *
 * Failure boundaries are DISTINGUISHED deliberately:
 *   - Clerk identity failures (missing keys, Clerk outage, no session) mean
 *     "we cannot tell who this visitor is" -> null, so callers fall back to
 *     the legacy session cookie (previous behavior preserved).
 *   - DATABASE failures (Prisma/pg) are NOT auth failures: they are
 *     rethrown so the request fails with a 5xx instead of being silently
 *     converted into a misleading signed-out state during a database
 *     outage.
 */
/**
 * Clerk user id -> MegaTube user memo (short TTL + in-flight sharing).
 * Same rationale as the legacy session memo in lib/auth.ts: one page load
 * issues ~50 auth lookups. The memo key is the Clerk identity, the value is
 * the immutable MegaTube user projection. Linking/unlinking is rare and
 * runs THROUGH this function (whose fresh run re-populates the memo);
 * disconnect/reconnect flows call it again. TTL default 10s, 0 disables.
 */
const clerkUserMemo = new TtlMemo<UserRecord>(authMemoTtlMs());

export function clearClerkUserMemoForTests(): void {
  clerkUserMemo.clear();
}

export async function getCurrentMegaUser(): Promise<UserRecord | null> {
  // 1. Clerk session id only (cheap, no Clerk Backend API call).
  let clerkUserId: string;
  try {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    if (!userId) return null;
    clerkUserId = userId;
  } catch (err) {
    console.warn(
      `[clerk] getCurrentMegaUser session lookup failed, treating as signed out: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
    );
    return null;
  }

  // 2. Memoized link lookup. DB failures inside still propagate (honest
  //    5xx) - the memo only shortcuts repeated READS, never failure modes.
  return clerkUserMemo.resolve(`clerk:${clerkUserId}`, () =>
    resolveMegaUserForClerkBySession(clerkUserId),
  );
}

/**
 * Resolve the MegaTube user for an ALREADY-VERIFIED Clerk identity:
 * direct link lookup first; on a miss, fetch the Clerk profile for
 * email-based linking. A Clerk Backend API failure here is an auth-side
 * failure (identity known, email not) -> null, preserving the legacy
 * fallback. The DB mapping stays OUTSIDE any catch: a database failure
 * must propagate (honest 5xx), never be converted into a signed-out state.
 */
async function resolveMegaUserForClerkBySession(clerkUserId: string): Promise<UserRecord | null> {
  const linked = await prisma.user.findUnique({
    where: { clerkUserId },
    select: SELECT,
  });
  if (linked) return linked;

  let email: string | null = null;
  try {
    const { currentUser } = await import('@clerk/nextjs/server');
    const clerkUser = await currentUser();
    email =
      clerkUser?.primaryEmailAddress?.emailAddress ??
      clerkUser?.emailAddresses?.[0]?.emailAddress ??
      null;
  } catch (err) {
    console.warn(
      `[clerk] getCurrentMegaUser profile lookup failed, treating as signed out: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
    );
    return null;
  }
  return await resolveMegaUserForClerk(clerkUserId, email);
}
