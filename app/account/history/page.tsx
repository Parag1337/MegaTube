import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { listHistory } from '@/lib/personal';
import { HistoryList } from '@/components/HistoryList';

export const metadata: Metadata = { title: 'History' };

export const dynamic = 'force-dynamic';

interface HistoryPageProps {
  searchParams: Promise<{ page?: string }>;
}

export default async function HistoryPage({ searchParams }: HistoryPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const result = await listHistory(user.id, page);

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        <HistoryList
          initialItems={result.items}
          page={result.page}
          totalPages={result.totalPages}
          initialTotal={result.total}
          basePath="/account/history"
        />
      </div>
    </div>
  );
}
