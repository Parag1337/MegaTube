import Link from 'next/link';

/**
 * Build the list of page numbers to show, with ellipsis markers.
 * Example (current=6, total=20): 1 … 4 5 [6] 7 8 … 20
 */
function pageWindow(current: number, total: number): (number | '…')[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push('…');
    out.push(p);
    prev = p;
  }
  return out;
}

export function Pagination({
  page,
  totalPages,
  basePath,
}: {
  page: number;
  totalPages: number;
  basePath: string;
}) {
  if (totalPages <= 1) return null;

  // basePath may already carry query params (e.g. "?account=3"); page is
  // (re)written as a query param so both combine cleanly.
  const hrefFor = (p: number) => {
    const u = new URL(basePath, 'http://localhost');
    if (p === 1) u.searchParams.delete('page');
    else u.searchParams.set('page', String(p));
    return u.pathname + u.search;
  };

  return (
    <nav className="mt-8 flex items-center justify-center gap-1" aria-label="Pagination">
      {page > 1 && (
        <Link
          href={hrefFor(page - 1)}
          className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-card"
        >
          ← Prev
        </Link>
      )}

      {pageWindow(page, totalPages).map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="px-1.5 text-muted">
            …
          </span>
        ) : (
          <Link
            key={p}
            href={hrefFor(p)}
            aria-current={p === page ? 'page' : undefined}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
              p === page
                ? 'bg-accent font-semibold text-white'
                : 'border border-border hover:bg-card'
            }`}
          >
            {p}
          </Link>
        ),
      )}

      {page < totalPages && (
        <Link
          href={hrefFor(page + 1)}
          className="rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-card"
        >
          Next →
        </Link>
      )}
    </nav>
  );
}