'use client';

import { useClerk, useUser } from '@clerk/nextjs';

/**
 * Opens Clerk's account-management UI (email, password/authentication,
 * profile, security). MegaTube never duplicates Clerk's account settings -
 * this page only manages MegaTube-specific things (MEGA accounts, library,
 * maintenance, preferences).
 */
export function ManageAccountButton() {
  const { openUserProfile } = useClerk();
  const { isSignedIn } = useUser();

  if (!isSignedIn) return null;

  return (
    <button
      type="button"
      onClick={() => openUserProfile()}
      className="inline-flex h-9 items-center rounded-full bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
    >
      Manage account
    </button>
  );
}
