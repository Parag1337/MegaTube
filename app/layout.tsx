import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { AppShell } from '@/components/AppShell';
import { ThemeProvider, themeInitScript } from '@/components/ThemeProvider';
import { SITE_NAME } from '@/lib/config';
import { getCurrentUser } from '@/lib/auth';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} - Your private video library`,
    template: `%s | ${SITE_NAME}`,
  },
  description: 'Browse, search, and watch your private MEGA video library.',
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  // Phase 3C: seed the shell's session state on the server so the FIRST
  // paint already shows the correct sidebar/header (no pop-in when the
  // client session resolves seconds later). Same getCurrentUser() the
  // client fetches; the provider still revalidates per route, so sign-outs
  // and cross-tab changes correct themselves exactly as before. Serialized
  // (client components require JSON-safe props).
  const sessionUser = await getCurrentUser().catch(() => null);
  const initialUser = sessionUser
    ? {
        id: sessionUser.id,
        email: sessionUser.email,
        createdAt: sessionUser.createdAt.toISOString(),
      }
    : null;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Apply the stored theme before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full bg-background text-foreground">
        {/* afterSignOutUrl: Clerk sign-outs land on /sign-out, which also
            clears any legacy website session before redirecting on. */}
        <ClerkProvider afterSignOutUrl="/sign-out">
          <ThemeProvider>
            <AppShell initialUser={initialUser}>{children}</AppShell>
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}