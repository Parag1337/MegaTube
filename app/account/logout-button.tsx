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
      className="rounded border border-border px-4 py-2 text-sm text-muted transition-colors hover:bg-card hover:text-foreground"
    >
      Logout
    </button>
  );
}
