import { Metadata } from 'next';
import { RegisterForm } from '@/components/RegisterForm';

export const metadata: Metadata = { title: 'Sign up' };

export default function RegisterPage() {
  return (
    <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm rounded-3xl border border-border bg-surface p-6 sm:p-8">
        <RegisterForm />
      </div>
    </div>
  );
}
