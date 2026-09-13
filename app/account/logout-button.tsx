'use client';

import { useRouter } from 'next/navigation';
import { useClerk } from '@clerk/nextjs';

export function LogoutButton() {
  const router = useRouter();
  const { signOut: clerkSignOut, user: clerkUser } = useClerk();

  async function handleLogout() {
    // Clear the legacy website session, then Clerk (if present).
    // /sign-in is the public authentication entry point.
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    if (clerkUser) {
      await clerkSignOut({ redirectUrl: '/sign-in' }).catch(() => {});
    }
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <button
      onClick={handleLogout}
      className="inline-flex h-9 items-center rounded-full border border-border px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      Sign out
    </button>
  );
}
