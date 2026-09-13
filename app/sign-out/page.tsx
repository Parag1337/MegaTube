import { redirect } from 'next/navigation';
import { logout } from '@/lib/auth';

/**
 * Combined sign-out landing page.
 *
 * Clerk's UserButton signs out of Clerk and then lands here
 * (afterSignOutUrl). Any legacy website session (/api/auth/* flow) is cleared
 * too, so the user is signed out of both identity layers before reaching
 * /sign-in, the public authentication entry point.
 */
export const dynamic = 'force-dynamic';

export default async function SignOutPage() {
  await logout().catch(() => {});
  redirect('/sign-in');
}
