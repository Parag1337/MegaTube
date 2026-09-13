import { Button, EmptyState } from '@/components/ui';
import { FilmIcon } from '@/components/icons';

/** Brand-consistent 404 for unknown video/creator routes (both call notFound()). */
export default function NotFound() {
  return (
    <div className="px-4 py-6 md:px-6">
      <div className="mx-auto max-w-[2000px]">
        <EmptyState
          icon={<FilmIcon className="h-7 w-7" />}
          title="This page doesn’t exist"
          body="The video or creator you’re looking for may have been removed or the link is wrong."
          action={
            <Button href="/" variant="primary">
              Back to Home
            </Button>
          }
        />
      </div>
    </div>
  );
}
