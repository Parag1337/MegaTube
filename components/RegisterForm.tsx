'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Field, inputClassName, Button } from '@/components/ui';
import { AlertIcon } from '@/components/icons';

export function RegisterForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, confirmPassword: confirm }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Something went wrong.');
        setLoading(false);
        return;
      }

      router.push('/account');
      router.refresh();
    } catch {
      setError('Something went wrong.');
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Create your account</h1>
        <p className="mt-1 text-sm text-muted">Your library stays private to you.</p>
      </div>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      <Field label="Email" htmlFor="email">
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          className={inputClassName}
        />
      </Field>

      <Field label="Password" htmlFor="password" hint="At least 8 characters.">
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className={inputClassName}
        />
      </Field>

      <Field label="Confirm password" htmlFor="confirm">
        <input
          id="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
          className={inputClassName}
        />
      </Field>

      <Button type="submit" variant="primary" disabled={loading} className="w-full">
        {loading ? 'Creating account…' : 'Sign up'}
      </Button>

      <p className="text-center text-sm text-muted">
        Already have an account? <Link href="/login" className="font-medium text-accent hover:underline">Sign in</Link>
      </p>
    </form>
  );
}
