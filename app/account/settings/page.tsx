import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { ManageAccountButton } from '@/components/ManageAccountButton';
import { ThemeSelector } from '@/components/ThemeSelector';

export const metadata: Metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-xl font-bold tracking-tight">Settings</h1>

        <section aria-labelledby="account-heading" className="mb-4 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="account-heading" className="text-[15px] font-semibold">Account</h2>
          <p className="mt-1 text-[13px] text-muted">
            Signed in as {user.email}. Email, password, and security settings are managed by Clerk.
          </p>
          <div className="mt-4">
            <ManageAccountButton />
          </div>
        </section>

        <section aria-labelledby="appearance-heading" className="mb-4 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="appearance-heading" className="text-[15px] font-semibold">Appearance</h2>
          <p className="mt-1 text-[13px] text-muted">
            Applies everywhere - library, player pages, dialogs, and the landing page.
          </p>
          <div className="mt-4">
            <ThemeSelector />
          </div>
        </section>

        <section aria-labelledby="mega-heading" className="mb-4 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="mega-heading" className="text-[15px] font-semibold">MEGA</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            Link, sync, reconnect, and remove your MEGA accounts from your{' '}
            <Link href="/account" className="font-medium text-accent hover:underline">
              Account page
            </Link>
            .
          </p>
        </section>

        <section aria-labelledby="data-heading" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="data-heading" className="text-[15px] font-semibold">Your data</h2>
          <p className="mt-1 text-[13px] text-muted">
            Everything below is private to your account.
          </p>
          <nav aria-label="Personal data" className="mt-3 flex flex-wrap gap-2">
            <Link
              href="/account/history"
              className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay"
            >
              Watch history
            </Link>
            <Link
              href="/watchlist"
              className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay"
            >
              Watchlist
            </Link>
            <Link
              href="/account/saved"
              className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay"
            >
              Saved videos
            </Link>
          </nav>
        </section>
      </div>
    </div>
  );
}
