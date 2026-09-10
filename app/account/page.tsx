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
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-semibold">Account</h1>

      <section className="mb-8 rounded border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">Website Account</h2>
        <div className="space-y-2 text-sm">
          <p>
            <span className="text-muted">Email:</span>{' '}
            <span className="font-medium">{user.email}</span>
          </p>
          <p>
            <span className="text-muted">Member since:</span>{' '}
            {user.createdAt.toLocaleDateString()}
          </p>
        </div>
      </section>

      <MegaAccountsPanel />

      <div className="mt-8">
        <LogoutButton />
      </div>
    </div>
  );
}
