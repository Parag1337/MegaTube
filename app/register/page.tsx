import { redirect } from 'next/navigation';

/**
 * Legacy website registration route, retained only for bookmark/back-compat.
 *
 * Website authentication is handled by Clerk at /sign-up. This route never
 * renders the old registration form - it redirects there.
 */
export default function RegisterPage() {
  redirect('/sign-up');
}
