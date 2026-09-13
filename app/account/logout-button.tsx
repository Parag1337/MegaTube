'use client';

import { useRouter } from 'next/navigation';

export function LogoutButton() {
  const router = useRouter();

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
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
