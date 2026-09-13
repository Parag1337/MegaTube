import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { AppShell } from '@/components/AppShell';
import { ThemeProvider, themeInitScript } from '@/components/ThemeProvider';
import { SITE_NAME } from '@/lib/config';
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

export default function RootLayout({ children }: LayoutProps<'/'>) {
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
            <AppShell>{children}</AppShell>
          </ThemeProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}