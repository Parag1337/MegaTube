import { NextRequest, NextResponse } from 'next/server';
import { logout } from '@/lib/auth';

/**
 * Destroy the website session.
 *
 * Returns a 303 redirect to /login so this endpoint works as a plain HTML
 * form action (see the Logout button in the header): the browser lands back
 * on a normal page instead of a raw JSON document. /login is the app's
 * public landing page (the home page itself requires authentication).
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
  return NextResponse.redirect(new URL('/login', request.url), 303);
}
