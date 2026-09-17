import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { RepairDashboard } from '@/components/RepairDashboard';

export const metadata: Metadata = { title: 'Repair Thumbnails' };

export const dynamic = 'force-dynamic';

export default async function RepairThumbnailsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-5xl">
        <nav aria-label="Breadcrumb" className="mb-4 text-[13px] text-muted">
          <Link href="/account" className="hover:text-foreground">Account</Link>
          <span aria-hidden> / </span>
          <span aria-current="page" className="text-foreground">Repair thumbnails</span>
        </nav>

        <h1 className="mb-2 text-xl font-bold tracking-tight">Repair thumbnails</h1>
        <p className="mb-6 max-w-3xl text-sm leading-relaxed text-muted">
          Replaces missing, black, or broken thumbnails with real frames extracted
          from your own videos. Thumbnails that already look good are left alone —
          only repair candidates do real work, and the run is safe to repeat any
          time. Watch live progress below as each video is classified, repaired,
          and verified.
        </p>

        <RepairDashboard />
      </div>
    </div>
  );
}
