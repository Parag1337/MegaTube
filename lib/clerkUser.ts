import { randomBytes } from 'crypto';
import { prisma } from './db';
import type { UserRecord } from './auth';

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
 * session, or null when signed out / unmappable. Null-safe: any Clerk
 * failure (missing keys, network) resolves to null so callers can fall
 * back to the legacy session cookie.
 */
export async function getCurrentMegaUser(): Promise<UserRecord | null> {
  try {
    const { auth, currentUser } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    if (!userId) return null;

    const linked = await prisma.user.findUnique({
      where: { clerkUserId: userId },
      select: SELECT,
    });
    if (linked) return linked;

    const clerkUser = await currentUser();
    const email =
      clerkUser?.primaryEmailAddress?.emailAddress ??
      clerkUser?.emailAddresses?.[0]?.emailAddress ??
      null;
    return await resolveMegaUserForClerk(userId, email);
  } catch (err) {
    console.warn(
      `[clerk] getCurrentMegaUser failed, treating as signed out: ${err instanceof Error ? err.message.slice(0, 120) : typeof err}`,
    );
    return null;
  }
}
