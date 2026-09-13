import { buildHomeFeedPage, type FeedPick } from '@/lib/homeFeed';
import { listMegaAccountsForUser, MEGA_ACCOUNT_STATUSES } from '@/lib/megaAccounts';
import { VideoGrid } from '@/components/VideoGrid';
import { Landing } from '@/components/Landing';
import { Pagination } from '@/components/Pagination';
import { EmptyState, Button } from '@/components/ui';
import { FilmIcon, LibraryIcon, RefreshIcon } from '@/components/icons';
import { getCurrentUser } from '@/lib/auth';

export const metadata = { title: 'Home' };

export const dynamic = 'force-dynamic';

interface HomeProps {
  searchParams: Promise<{ page?: string }>;
}

/*
 * `/` serves two audiences:
 * - Logged-out visitors get the public landing page (the route is public
 *   in proxy.ts; nothing private is queried for them).
 * - Logged-in users get the Home feed, composed by the quota-based
 *   builder in lib/homeFeed.ts. Page 1 groups its picks into labeled
 *   sections (Recently added / Recommended / Browse your library) from
 *   the picks' existing feedSource tags - no extra queries, no
 *   composition change. Later pages render as one continuous grid.
 */

export default async function HomePage({ searchParams }: HomeProps) {
  const user = await getCurrentUser();
  if (!user) return <Landing />;

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const [accounts, feed] = await Promise.all([
    listMegaAccountsForUser(user.id),
    buildHomeFeedPage(user.id, page),
  ]);
  const linkedAccounts = accounts.filter(
    (a) => a.status !== MEGA_ACCOUNT_STATUSES.DISCONNECTED,
  );

  // No linked MEGA account -> no private videos -> welcome empty state.
  // Never render catalog or placeholder videos for a fresh user.
  if (linkedAccounts.length === 0) {
    return (
      <div className="px-4 py-6 md:px-6">
        <div className="mx-auto max-w-[2000px]">
          <h1 className="mb-6 text-xl font-bold tracking-tight">Home</h1>
          <EmptyState
            icon={<LibraryIcon className="h-7 w-7" />}
            title="Welcome to MegaTube"
            body={
              <>
                Your private video library is empty.
                <br />
                Connect a MEGA account to start building your private library.
              </>
            }
            action={
              <Button href="/account" variant="primary">
                Go to Account
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  if (feed.items.length === 0) {
    return (
      <div className="px-4 py-6 md:px-6">
        <div className="mx-auto max-w-[2000px]">
          <h1 className="mb-6 text-xl font-bold tracking-tight">Home</h1>
          <EmptyState
            icon={<FilmIcon className="h-7 w-7" />}
            title="Your library is empty"
            body={
              <>
                Connect a MEGA account and run a sync — your videos will show
                up here as soon as they finish indexing.
              </>
            }
            action={
              <Button href="/account" variant="primary">
                <RefreshIcon className="h-4 w-4" />
                Connect a MEGA account
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h1 className="text-xl font-bold tracking-tight">Home</h1>
          <p className="shrink-0 text-[13px] text-muted">
            {feed.total} video{feed.total === 1 ? '' : 's'} in your library
          </p>
        </div>
        {page === 1 ? (
          <HomeSections items={feed.items} />
        ) : (
          <VideoGrid
            videos={feed.items.map((pick) => ({ ...pick.video, feedSource: pick.source }))}
          />
        )}
        <Pagination page={feed.page} totalPages={feed.totalPages} basePath="/" />
      </div>
    </div>
  );
}

/**
 * Page-1 sections, grouped from the feed's own source tags. A section
 * renders only when its picks are non-empty, so small libraries and
 * history-free users get fewer, honest sections - never placeholders.
 */
function HomeSections({ items }: { items: FeedPick[] }) {
  const recent = items.filter((p) => p.source === 'recent');
  const recommended = items.filter((p) => p.source === 'history' || p.source === 'related');
  const browse = items.filter((p) => p.source === 'random' || p.source === 'variety');

  // Degenerate case (shouldn't happen, but): fall back to one grid.
  if (recent.length === 0 && recommended.length === 0) {
    return (
      <VideoGrid
        videos={items.map((pick) => ({ ...pick.video, feedSource: pick.source }))}
        priorityStart={4}
      />
    );
  }

  const sections: Array<{ title: string; body: string; picks: FeedPick[] }> = [];
  if (recent.length > 0) {
    sections.push({
      title: 'Recently added',
      body: 'The newest videos in your library',
      picks: recent,
    });
  }
  if (recommended.length > 0) {
    sections.push({
      title: 'Recommended',
      body: 'Related to your recent watches and newest adds',
      picks: recommended,
    });
  }
  if (browse.length > 0) {
    sections.push({
      title: 'Browse your library',
      body: 'More from across your collection',
      picks: browse,
    });
  }

  return (
    <div className="space-y-10">
      {sections.map((section, i) => (
        <section key={section.title} aria-labelledby={`home-section-${i}`}>
          <div className="mb-4">
            <h2 id={`home-section-${i}`} className="text-base font-semibold tracking-tight">
              {section.title}
            </h2>
            <p className="mt-0.5 text-[13px] text-muted">{section.body}</p>
          </div>
          <VideoGrid
            videos={section.picks.map((pick) => ({ ...pick.video, feedSource: pick.source }))}
            priorityStart={i === 0 ? 4 : 0}
          />
        </section>
      ))}
    </div>
  );
}
