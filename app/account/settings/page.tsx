import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-xl font-bold tracking-tight">Settings</h1>

        <section aria-labelledby="website-heading" className="mb-4 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="website-heading" className="text-[15px] font-semibold">Website account</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted">Email</dt>
              <dd className="truncate font-medium">{user.email}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
              <dt className="text-muted">Password</dt>
              <dd className="text-right text-[13px] text-muted">Password changes aren’t available yet.</dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="mega-heading" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="mega-heading" className="text-[15px] font-semibold">MEGA accounts</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Link, sync, reconnect, and remove your MEGA accounts from your{' '}
            <Link href="/account" className="font-medium text-accent hover:underline">
              Account page
            </Link>
            .
          </p>
        </section>
      </div>
    </div>
  );
}
