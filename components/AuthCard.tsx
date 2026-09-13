'use client';

import { SignIn, SignUp } from '@clerk/nextjs';
import { useTheme } from '@/components/ThemeProvider';
import type { ResolvedTheme } from '@/components/ThemeProvider';

/**
 * Clerk authentication components styled as MegaTube.
 *
 * Clerk renders its own card (including error and loading states), so
 * this wrapper only supplies theme-aware `appearance` variables: the
 * resolved System/Light/Dark theme picks the variable set, and Clerk
 * re-renders on theme change. Routing behavior is untouched - the only
 * additions are explicit cross-links (/sign-in <-> /sign-up) and a
 * post-auth landing on `/` (the logged-in Home feed).
 */

function appearanceFor(resolved: ResolvedTheme) {
  const dark = resolved === 'dark';
  return {
    variables: {
      colorPrimary: dark ? '#ff0033' : '#e80032',
      colorBackground: dark ? '#171717' : '#ffffff',
      colorInputBackground: dark ? '#1e1e1e' : '#ffffff',
      colorInputText: dark ? '#f1f1f1' : '#18181b',
      colorText: dark ? '#f1f1f1' : '#18181b',
      colorTextSecondary: dark ? '#aaaaaa' : '#52525b',
      colorTextOnPrimaryBackground: '#ffffff',
      colorNeutral: dark ? '#f1f1f1' : '#18181b',
      colorDanger: dark ? '#f87171' : '#dc2626',
      borderRadius: '0.75rem',
      fontFamily: 'var(--font-geist-sans), system-ui, sans-serif',
    },
    elements: {
      rootBox: 'w-full',
      cardBox: 'w-full shadow-none',
      card: dark ? 'border border-[#262626] shadow-none' : 'border border-[#e4e4e7] shadow-none',
      headerTitle: 'tracking-tight',
      formButtonPrimary: 'rounded-full',
      footerActionLink: dark ? 'text-[#ff0033] hover:text-[#d6002b]' : 'text-[#e80032] hover:text-[#c2002a]',
    },
  } as const;
}

export function SignInCard() {
  const { resolved } = useTheme();
  return (
    <SignIn
      appearance={appearanceFor(resolved)}
      signUpUrl="/sign-up"
      fallbackRedirectUrl="/"
    />
  );
}

export function SignUpCard() {
  const { resolved } = useTheme();
  return (
    <SignUp
      appearance={appearanceFor(resolved)}
      signInUrl="/sign-in"
      fallbackRedirectUrl="/"
    />
  );
}
