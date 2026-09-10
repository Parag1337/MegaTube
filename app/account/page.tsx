import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { LogoutButton } from './logout-button';
import { MegaAccountsPanel } from '@/components/MegaAccountsPanel';

export const metadata: Metadata = { title: 'Account' };

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-8 text-2xl font-semibold">Account</h1>

        <section className="mb-8 rounded-lg border border-border bg-surface p-6">
          <h2 className="mb-4 text-lg font-semibold">Website Account</h2>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted">Email</span>
              <span className="font-medium">{user.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Member since</span>
              <span>{user.createdAt.toLocaleDateString()}</span>
            </div>
          </div>
        </section>

        <MegaAccountsPanel />

        <div className="mt-8">
          <LogoutButton />
        </div>
      </div>
    </div>
  );
}
