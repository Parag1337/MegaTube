'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SearchBar() {
  const router = useRouter();
  const [value, setValue] = useState('');

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = value.trim();
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }

  return (
    <form onSubmit={handleSubmit} role="search" className="flex-1 max-w-xl">
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search videos..."
        aria-label="Search videos"
        className="w-full rounded-full border border-border bg-card px-4 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
      />
    </form>
  );
}
