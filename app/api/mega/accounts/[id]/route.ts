import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getMegaAccountForUser, disconnectMegaAccount } from '@/lib/megaAccounts';
import { openMegaSession, logoutMegaSession, validateSessionMaterial } from '@/lib/mega/account';
import { decryptSecret } from '@/lib/mega/envelope';
import { evictMegaSession } from '@/lib/sync/session-cache';
import type { MegaSessionMaterial } from '@/lib/mega/account';

/**
 * Disconnect a MEGA account (owner only).
 *
 * - best-effort kills the session on MEGA's side (a=sml)
 * - deletes ALL stored authentication material from the database
 * - marks the account DISCONNECTED; its videos are preserved (hidden) by
 *   design and unaffected for any other account
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 });
    }

    const account = await getMegaAccountForUser(id, user.id);
    if (!account) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 });
    }

    // Best-effort server-side session kill. If the stored session is already
    // dead this simply fails and we continue - local material is wiped either
    // way. We never surface details here (a failing sml is not an error for
    // the user).
    if (account.encryptedSession) {
      try {
        const material = JSON.parse(
          decryptSecret(account.encryptedSession).toString('utf8'),
        ) as MegaSessionMaterial;
        if (validateSessionMaterial(material)) {
          const storage = await openMegaSession(material);
          await logoutMegaSession(storage);
        }
      } catch {
        // Expected: the stored session may already be expired/revoked.
        // Nothing to do - local material is deleted below regardless.
      }
    }

    evictMegaSession(id);
    await disconnectMegaAccount(id, user.id);

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
