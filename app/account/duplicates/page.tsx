import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { DuplicatesFinder } from '@/components/DuplicatesFinder';

export const metadata: Metadata = { title: 'Find Duplicates' };

export const dynamic = 'force-dynamic';

export default async function DuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const raw = (await searchParams).accountId;
  const parsed = Number(raw);
  const initialAccountId = raw !== undefined && Number.isInteger(parsed) && parsed > 0 ? parsed : null;

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        <nav aria-label="Breadcrumb" className="mb-4 text-[13px] text-muted">
          <Link href="/account" className="hover:text-foreground">Account</Link>
          <span aria-hidden> / </span>
          <span aria-current="page" className="text-foreground">Find Duplicates</span>
        </nav>

        <h1 className="mb-2 text-xl font-bold tracking-tight">Find Duplicates</h1>
        <p className="mb-6 text-sm leading-relaxed text-muted">
          Files with similar titles and matching sizes are grouped as possible
          duplicates — across all your MEGA accounts by default, or one
          account at a time. These are candidates, not proven identical —
          review each group and choose which copies to delete. At least one
          copy in each group is always kept.
        </p>

        <section aria-label="Duplicate scanner" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
          <DuplicatesFinder initialAccountId={initialAccountId} />
        </section>
      </div>
    </div>
  );
}
