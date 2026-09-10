import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { reconnectMegaAccount, RECONNECT_ERROR_RESPONSES } from '@/lib/mega/reconnect';

/**
 * Explicit user-driven MEGA reconnection (Phase 2).
 *
 * Thin HTTP wrapper around lib/mega/reconnect.ts (see there for the full
 * flow and security notes). This is the ONLY endpoint that accepts MEGA
 * credentials. Requirements enforced here:
 *
 *   - authenticated MegaTube user (cookie session)
 *   - MegaAccount ownership verified inside the reconnect flow (IDOR-safe:
 *     foreign ids map to 404)
 *   - credentials accepted ONLY on this explicit POST; GET requests, page
 *     loads, the scheduler, and Sync Now never authenticate with a password
 *   - reusable session material is captured, verified via the password-less
 *     resume path, AES-256-GCM-encrypted, and stored in MegaAccount
 *   - status CONNECTED is set only after persistence actually succeeded
 *   - failures keep the account REAUTH_REQUIRED with a safe error message
 *   - the response never contains credentials or session material
 *   - no sync is triggered (the user clicks Sync Now afterwards)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'Invalid account id.' }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  const mfaCode =
    typeof body?.mfaCode === 'string' && body.mfaCode ? body.mfaCode.trim() : undefined;

  const outcome = await reconnectMegaAccount(id, user.id, password, mfaCode);
  if (!outcome.ok) {
    const mapped = RECONNECT_ERROR_RESPONSES[outcome.reason];
    return NextResponse.json({ error: outcome.message }, { status: mapped.status });
  }

  // Public account fields only - never credentials, never session material.
  return NextResponse.json({
    ok: true,
    account: {
      id,
      status: 'CONNECTED',
      lastAuthenticatedAt: new Date().toISOString(),
    },
  });
}
