import { Metadata } from 'next';
import { RegisterForm } from '@/components/RegisterForm';

export const metadata: Metadata = { title: 'Sign Up' };

export default function RegisterPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <RegisterForm />
    </div>
  );
}
