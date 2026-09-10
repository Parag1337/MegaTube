import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Account Settings' };

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="mb-8 text-2xl font-semibold">Account Settings</h1>

      <section className="mb-8 rounded border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">Website Account</h2>
        <div className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-muted">Email</label>
            <p className="text-sm">{user.email}</p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-muted">Password</label>
            <p className="text-sm text-muted">Password changes will be available in a future update.</p>
          </div>
        </div>
      </section>

      <section className="rounded border border-border bg-card p-6">
        <h2 className="mb-4 text-lg font-semibold">Connected MEGA Accounts</h2>
        <p className="text-sm text-muted">
          MEGA account linking and management is on your{' '}
          <Link href="/account" className="text-accent hover:underline">
            Account page
          </Link>
          .
        </p>
      </section>
    </div>
  );
}
