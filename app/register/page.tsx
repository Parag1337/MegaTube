import { Metadata } from 'next';
import { RegisterForm } from '@/components/RegisterForm';

export const metadata: Metadata = { title: 'Sign up' };

export default function RegisterPage() {
  return (
    <div className="flex min-h-[calc(100vh-14rem)] items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-sm">
        <RegisterForm />
      </div>
    </div>
  );
}
