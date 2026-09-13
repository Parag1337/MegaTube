import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { LogoutButton } from './logout-button';
import { ManageAccountButton } from '@/components/ManageAccountButton';
import { RepairThumbsButton } from './RepairThumbsButton';
import { MegaAccountsPanel } from '@/components/MegaAccountsPanel';
import { Avatar } from '@/components/ui';
import { BookmarkIcon, ChevronRightIcon, HistoryIcon } from '@/components/icons';

export const metadata: Metadata = { title: 'Account' };

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-6 text-xl font-bold tracking-tight">Account</h1>

        <section aria-labelledby="profile-heading" className="mb-6 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <div className="flex items-center gap-4">
            <Avatar name={user.email} size="lg" />
            <div className="min-w-0">
              <h2 id="profile-heading" className="truncate text-[15px] font-semibold">{user.email}</h2>
              <p className="mt-0.5 text-[13px] text-muted">
                Member since {user.createdAt.toLocaleDateString()}
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
            <ManageAccountButton />
            <Link
              href="/account/settings"
              className="inline-flex h-9 items-center rounded-full bg-surface-raised px-4 text-sm font-medium text-foreground hover:bg-surface-overlay"
            >
              Settings
            </Link>
            <LogoutButton />
          </div>
        </section>

        <section aria-labelledby="library-heading" className="mb-6 rounded-2xl border border-border bg-surface p-2 sm:p-3">
          <h2 id="library-heading" className="px-3 pb-1 pt-2 text-xs font-medium text-muted">
            Your library
          </h2>
          <nav aria-label="Personal library">
            <LibraryRow
              href="/watchlist"
              icon={<BookmarkIcon className="h-[20px] w-[20px]" />}
              title="Watchlist"
              body="Videos you bookmarked for later"
            />
            <LibraryRow
              href="/account/history"
              icon={<HistoryIcon className="h-[20px] w-[20px]" />}
              title="Watch history"
              body="Everything you've watched, newest first"
            />
            <LibraryRow
              href="/account/saved"
              icon={<BookmarkIcon className="h-[20px] w-[20px]" />}
              title="Saved Videos"
              body="Your bookmarks, organized in folders"
            />
          </nav>
        </section>

        <MegaAccountsPanel />

        <section aria-labelledby="maintenance-heading" className="mt-6 rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <h2 id="maintenance-heading" className="text-[15px] font-semibold">
            Maintenance
          </h2>
          <p className="mt-1 text-[13px] text-muted">
            Replace missing or black thumbnails with real frames from your videos. Good thumbnails are left alone.
          </p>
          <div className="mt-3">
            <RepairThumbsButton />
          </div>
        </section>
      </div>
    </div>
  );
}

function LibraryRow({
  href,
  icon,
  title,
  body,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-surface-hover"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-raised text-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{title}</span>
        <span className="block truncate text-[13px] text-muted">{body}</span>
      </span>
      <ChevronRightIcon className="h-5 w-5 shrink-0 text-muted-light" />
    </Link>
  );
}
