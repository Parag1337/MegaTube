import { redirect } from 'next/navigation';

/**
 * Legacy website login route, retained only for bookmark/back-compat.
 *
 * Website authentication is handled by Clerk at /sign-in. This route never
 * renders the old email/password form - it redirects there.
 */
export default function LoginPage() {
  redirect('/sign-in');
}
