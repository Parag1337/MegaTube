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
    <form onSubmit={handleSubmit} role="search" className="relative w-full">
      <div className="relative flex items-center">
        <svg 
          className="absolute left-3 h-4 w-4 text-muted" 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2" 
          strokeLinecap="round" 
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8"/>
          <path d="m21 21-4.3-4.3"/>
        </svg>
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Search"
          aria-label="Search videos"
          className="w-full rounded-full border border-border bg-surface px-10 py-2 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>
    </form>
  );
}
