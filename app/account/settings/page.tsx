import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { ManageAccountButton } from '@/components/ManageAccountButton';
import { ThemeSelector } from '@/components/ThemeSelector';
import { canManagePreviews } from '@/lib/preview/admin';

export const metadata: Metadata = { title: 'Settings' };

export const dynamic = 'force-dynamic';

export default async function AccountSettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  // The routes re-check this server-side; the gate here only avoids showing
  // administrative controls to a user the server would reject anyway.
  const showPreviewAdmin = canManagePreviews(user);

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

        <section aria-labelledby="tools-heading" className="mb-4">
          <h2 id="tools-heading" className="mb-3 text-[15px] font-semibold">Tools</h2>
          <div className="grid gap-3">
            <Link
              href="/account/tools/repair-thumbnails"
              className="rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-border-light hover:bg-surface-raised sm:p-6"
            >
              <span className="block text-[15px] font-semibold">Repair Thumbnails</span>
              <span className="mt-1 block text-[13px] text-muted">
                Replace missing, black, or broken thumbnails with real video frames.
              </span>
            </Link>
            <Link
              href="/account/duplicates"
              className="rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-border-light hover:bg-surface-raised sm:p-6"
            >
              <span className="block text-[15px] font-semibold">Find Duplicates</span>
              <span className="mt-1 block text-[13px] text-muted">
                Review possible duplicate files across your MEGA accounts.
              </span>
            </Link>
            {showPreviewAdmin && (
              <Link
                href="/account/previews"
                className="rounded-2xl border border-border bg-surface p-5 transition-colors hover:border-border-light hover:bg-surface-raised sm:p-6"
              >
                <span className="block text-[15px] font-semibold">Fix Previews</span>
                <span className="mt-1 block text-[13px] text-muted">
                  Manage preview generation →
                </span>
              </Link>
            )}
          </div>
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
