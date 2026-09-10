import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  listMegaAccountsForUser,
  createMegaAccount,
  sanitizeLabel,
  MEGA_ACCOUNT_STATUSES,
} from '@/lib/megaAccounts';
import { hasEnvelopeKey } from '@/lib/mega/envelope';
import { loginToMega, MegaError } from '@/lib/mega/account';
import { getSyncProgress, enqueueSync } from '@/lib/sync';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }
    const accounts = await listMegaAccountsForUser(user.id);
    return NextResponse.json({
      accounts: accounts.map((a) => ({
        ...a,
        progress: getSyncProgress(a.id),
      })),
    });
  } catch {
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
    }

    if (!hasEnvelopeKey()) {
      return NextResponse.json(
        {
          error:
            'MEGA linking is not configured on this server (MEGA_SESSION_ENCRYPTION_KEY missing).',
        },
        { status: 500 },
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const label = typeof body?.label === 'string' ? sanitizeLabel(body.label) : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    // The password is used exactly once (the MEGA login call below) and is
    // never stored, logged, or echoed back in any response.
    const password = typeof body?.password === 'string' ? body.password : '';
    const mfaCode = typeof body?.mfaCode === 'string' && body.mfaCode ? body.mfaCode.trim() : undefined;

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'Enter a valid MEGA account email.' }, { status: 400 });
    }
    if (!password) {
      return NextResponse.json({ error: 'Enter your MEGA account password.' }, { status: 400 });
    }

    const existing = await prisma.megaAccount.findUnique({
      where: { userId_megaEmail: { userId: user.id, megaEmail: email } },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== MEGA_ACCOUNT_STATUSES.DISCONNECTED) {
      return NextResponse.json(
        { error: 'This MEGA account is already linked.' },
        { status: 409 },
      );
    }

    let material;
    try {
      material = await loginToMega(email, password, mfaCode);
    } catch (err) {
      if (err instanceof MegaError) {
        if (err.kind === 'mfa') {
          return NextResponse.json(
            { error: 'This MEGA account requires a 2FA code. Enter it and try again.' },
            { status: 401 },
          );
        }
        if (err.kind === 'transient') {
          return NextResponse.json(
            { error: 'MEGA is temporarily unavailable. Please try again in a moment.' },
            { status: 502 },
          );
        }
        return NextResponse.json(
          { error: 'MEGA login failed. Check the email and password for this MEGA account.' },
          { status: 401 },
        );
      }
      return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
    }

    const account = await createMegaAccount({
      userId: user.id,
      label,
      email,
      material,
    });

    // Kick off the initial synchronization in the background.
    await enqueueSync(account.id, 'connect');

    // Response is strictly limited to safe public fields.
    return NextResponse.json(
      {
        account: {
          id: account.id,
          label: account.label,
          megaEmail: account.megaEmail,
          status: account.status,
          lastAuthenticatedAt: account.lastAuthenticatedAt,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'already-linked') {
      return NextResponse.json(
        { error: 'This MEGA account is already linked.' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
