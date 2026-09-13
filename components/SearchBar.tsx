'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SearchIcon, CloseIcon } from '@/components/icons';

export function SearchBar({
  initialValue = '',
  autoFocus = false,
  id = 'site-search',
  onSubmitted,
}: {
  initialValue?: string;
  autoFocus?: boolean;
  id?: string;
  onSubmitted?: () => void;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
    onSubmitted?.();
  }

  return (
    <form onSubmit={handleSubmit} role="search" className="w-full">
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-4 text-muted" aria-hidden>
          <SearchIcon className="h-[18px] w-[18px]" />
        </span>
        <input
          id={id}
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search videos and creators"
          aria-label="Search videos and creators"
          autoFocus={autoFocus}
          className="h-10 w-full rounded-full border border-border bg-surface pl-11 pr-10 text-sm text-foreground placeholder:text-muted-light focus:border-border-light focus:bg-surface-raised focus:outline-none"
        />
        {value && (
          <button
            type="button"
            onClick={() => setValue('')}
            aria-label="Clear search"
            className="absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-surface-hover hover:text-foreground"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        )}
      </div>
    </form>
  );
}
