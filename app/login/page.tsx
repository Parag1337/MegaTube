import { Metadata } from 'next';
import { LoginForm } from '@/components/LoginForm';

export const metadata: Metadata = { title: 'Login' };

export default function LoginPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <LoginForm />
    </div>
  );
}
