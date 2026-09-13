/**
 * Shared UI primitives: one button voice, one avatar, one skeleton family,
 * one empty state, one form field. Pages compose these instead of inventing
 * their own so the whole product feels like one product.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------- Button ---

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover',
  secondary: 'bg-surface-raised text-foreground hover:bg-surface-overlay',
  ghost: 'text-muted hover:bg-surface-hover hover:text-foreground',
  danger: 'bg-destructive/15 text-destructive hover:bg-destructive/25',
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
};

interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  href?: string;
  type?: 'button' | 'submit';
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  ariaLabel?: string;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  href,
  type = 'button',
  disabled,
  onClick,
  ariaLabel,
}: ButtonProps) {
  const cls = `inline-flex items-center justify-center gap-2 rounded-full font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`;
  if (href && !disabled) {
    return (
      <Link href={href} className={cls} aria-label={ariaLabel} onClick={onClick}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} disabled={disabled} onClick={onClick} className={cls} aria-label={ariaLabel}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- Avatar ---

export function Avatar({
  name,
  photoUrl,
  size = 'md',
  className = '',
}: {
  name: string;
  photoUrl?: string | null;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const sizes = {
    sm: 'h-8 w-8 text-xs',
    md: 'h-9 w-9 text-sm',
    lg: 'h-12 w-12 text-lg',
    xl: 'h-16 w-16 text-2xl sm:h-20 sm:w-20 sm:text-3xl',
  } as const;
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt=""
        loading="lazy"
        className={`shrink-0 rounded-full object-cover ${sizes[size]} ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent ${sizes[size]} ${className}`}
    >
      {(name.charAt(0) || '?').toUpperCase()}
    </span>
  );
}

// --------------------------------------------------------------- Skeleton ---

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`mt-skeleton rounded-lg ${className}`} />;
}

/** Approximates one video card: 16:9 thumb + two text lines. */
export function VideoCardSkeleton() {
  return (
    <div aria-hidden>
      <Skeleton className="aspect-video w-full !rounded-xl" />
      <div className="mt-3 flex gap-3">
        <Skeleton className="h-9 w-9 shrink-0 !rounded-full" />
        <div className="min-w-0 flex-1 space-y-2 pt-0.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    </div>
  );
}

export function VideoGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div role="status" aria-label="Loading videos">
      <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: count }, (_, i) => (
          <VideoCardSkeleton key={i} />
        ))}
      </div>
      <span className="sr-only">Loading videos…</span>
    </div>
  );
}

// ------------------------------------------------------------ Empty state ---

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[380px] items-center justify-center rounded-2xl border border-border bg-surface px-6 py-16">
      <div className="max-w-sm text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-raised text-muted">
          {icon}
        </div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {body && <div className="mt-2 text-sm leading-relaxed text-muted">{body}</div>}
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Field ---

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1.5 block text-[13px] font-medium text-foreground"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-[13px] text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-[13px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClassName =
  'h-11 w-full rounded-xl border border-border bg-surface px-4 text-sm text-foreground placeholder:text-muted-light focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';

// -------------------------------------------------------------- StatusDot ---

export function StatusDot({ tone, className = '' }: { tone: 'live' | 'ok' | 'warn' | 'muted'; className?: string }) {
  const tones = {
    live: 'bg-accent',
    ok: 'bg-success',
    warn: 'bg-warning',
    muted: 'bg-muted-light',
  } as const;
  return (
    <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${tones[tone]} ${className}`} />
  );
}
