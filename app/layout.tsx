import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Header } from '@/components/Header';
import { SITE_NAME } from '@/lib/config';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: {
    default: `${SITE_NAME} - Video Discovery`,
    template: `%s | ${SITE_NAME}`,
  },
  description: 'Discover videos from MEGA public links.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Header />
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
          {children}
        </main>
        <footer className="border-t border-border px-4 py-6 text-center text-sm text-muted">
          {SITE_NAME} — a video discovery catalog powered by MEGA public links.
        </footer>
      </body>
    </html>
  );
}