import { NextRequest, NextResponse } from 'next/server';
import { logout } from '@/lib/auth';

/**
 * Destroy the website session.
 *
 * Returns a 303 redirect to /sign-in so this endpoint works as a plain HTML
 * form action (see the Logout button in the header): the browser lands back
 * on a normal page instead of a raw JSON document. /sign-in is the app's
 * public authentication entry point (the home page itself requires
 * authentication).
 * The redirect target is derived from the incoming request URL, so whichever
 * host the browser used (localhost, LAN IP, Tailscale IP) is preserved.
 * Client-side callers (fetch) are unaffected - fetch follows the redirect
 * transparently.
 */
export async function POST(request: NextRequest) {
  try {
    await logout();
  } catch {
    // Even on an unexpected error, send the user somewhere sane; the session
    // cookie deletion inside logout() is best-effort and idempotent.
  }
  return NextResponse.redirect(new URL('/sign-in', request.url), 303);
}
