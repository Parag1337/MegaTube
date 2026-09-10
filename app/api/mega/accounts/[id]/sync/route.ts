import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { getMegaAccountForUser, MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { enqueueSync } from '@/lib/sync';

/**
 * Manually trigger a synchronization for one MEGA account (owner only).
 * The sync runs in the background; the client polls the account list for
 * status updates.
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

    if (account.status === MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
      return NextResponse.json(
        { error: 'This account is disconnected. Reconnect it first.' },
        { status: 409 },
      );
    }
    if (account.status === MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED) {
      return NextResponse.json(
        { error: 'This account needs re-authentication before it can sync.' },
        { status: 409 },
      );
    }

    const outcome = await enqueueSync(id, 'manual');
    if (outcome === 'already-pending') {
      return NextResponse.json({ queued: false, alreadyPending: true });
    }
    if (outcome === 'not-eligible') {
      return NextResponse.json({ error: 'This account cannot sync right now.' }, { status: 409 });
    }
    return NextResponse.json({ queued: true }, { status: 202 });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
