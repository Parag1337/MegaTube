'use client';

/**
 * Bulk actions for the Watchlist page header.
 *
 * Play All opens every currently loaded watchlist video in its own new
 * browser tab (the normal video page - no playlist/queue system). All
 * window.open calls run synchronously inside the click handler so popup
 * blockers treat them as one user gesture. On paginated lists only the
 * current page's items open.
 *
 * Download All is an honest placeholder: visibly disabled and marked
 * "Coming soon". No download API, queue, or background system exists yet.
 */

import { Button } from '@/components/ui';

export function WatchlistActions({ slugs }: { slugs: string[] }) {
  function playAll() {
    for (const slug of slugs) {
      window.open(`/video/${slug}`, '_blank', 'noopener');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" onClick={playAll} disabled={slugs.length === 0}>
        Play All
      </Button>
      <span className="inline-flex items-center gap-2">
        <Button disabled ariaLabel="Download all (coming soon)">
          Download All
        </Button>
        <span className="text-xs text-muted">Coming soon</span>
      </span>
    </div>
  );
}
