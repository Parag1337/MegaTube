import { Metadata } from 'next';
import { LoginForm } from '@/components/LoginForm';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <LoginForm />
      </div>
    </div>
  );
}
