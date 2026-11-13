import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { ChevronLeftIcon } from '@/components/icons';
import { PreviewManagement } from '@/components/PreviewManagement';
import { canManagePreviews } from '@/lib/preview/admin';

export const metadata: Metadata = { title: 'Fix Previews' };

export const dynamic = 'force-dynamic';

export default async function FixPreviewsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');
  if (!canManagePreviews(user)) redirect('/account');

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/account"
          className="mb-4 inline-flex items-center gap-1 text-[13px] font-medium text-muted transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="h-4 w-4" />
          Back to Account
        </Link>

        <h1 className="text-xl font-bold tracking-tight">Fix Previews</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted">
          Find missing, invalid, or outdated previews and generate them in the background —
          they keep going even after you leave this page.
        </p>

        <div className="mt-5">
          <PreviewManagement hideHeader />
        </div>
      </div>
    </div>
  );
}
