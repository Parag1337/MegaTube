import { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getCurrentUser } from '@/lib/auth';
import { listSavedVideos } from '@/lib/personal';
import { listSavedFolders } from '@/lib/savedFolders';
import { SavedLibrary } from '@/components/SavedLibrary';
import { EmptyState } from '@/components/ui';
import { BookmarkIcon } from '@/components/icons';

export const metadata: Metadata = { title: 'Saved Videos' };

export const dynamic = 'force-dynamic';

interface SavedPageProps {
  searchParams: Promise<{ page?: string; folder?: string }>;
}

export default async function SavedVideosPage({ searchParams }: SavedPageProps) {
  const user = await getCurrentUser();
  if (!user) redirect('/sign-in');

  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const rawFolder = params.folder ?? 'all';

  const folders = await listSavedFolders(user.id);

  // Resolve the folder view: 'all' | numeric own-folder id. Unknown ids and
  // 'none' fall back to All Saved (uncategorized videos are visible there).
  const folderId = rawFolder === 'all' || rawFolder === 'none' ? null : Number(rawFolder);
  const activeFolder = folderId !== null && folders.some((f) => f.id === folderId) ? folderId : null;
  const filter = activeFolder !== null ? { kind: 'folder' as const, folderId: activeFolder } : { kind: 'all' as const };
  const basePath =
    activeFolder !== null ? `/account/saved?folder=${activeFolder}` : '/account/saved';

  const [result, totalAll] = await Promise.all([
    listSavedVideos(user.id, page, filter),
    // The "All Saved" count for the header: free when already viewing all.
    filter.kind === 'all'
      ? null
      : listSavedVideos(user.id, 1, { kind: 'all' }).then((r) => r.total),
  ]);

  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-3xl">
        {rawFolder !== 'all' && rawFolder !== 'none' && activeFolder === null ? (
          <>
            <h1 className="mb-5 text-xl font-bold tracking-tight">Saved Videos</h1>
            <EmptyState
              icon={<BookmarkIcon className="h-7 w-7" />}
              title="Folder not found"
              body="This folder does not exist or belongs to another account."
              action={
                <Link
                  href="/account/saved"
                  className="inline-flex h-10 items-center rounded-full bg-accent px-5 text-sm font-medium text-white hover:bg-accent-hover"
                >
                  Back to All Saved
                </Link>
              }
            />
          </>
        ) : (
          <SavedLibrary
            folders={folders}
            videos={result.items}
            total={result.total}
            totalAll={totalAll ?? result.total}
            page={result.page}
            totalPages={result.totalPages}
            basePath={basePath}
            currentFolder={activeFolder ?? 'all'}
            currentFolderName={activeFolder !== null ? (folders.find((f) => f.id === activeFolder)?.name ?? null) : null}
          />
        )}
      </div>
    </div>
  );
}
