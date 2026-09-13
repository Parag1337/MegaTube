import Link from 'next/link';
import { SignInCard } from '@/components/AuthCard';
import { BookmarkIcon, HistoryIcon, MegaTubeMark, PlayIcon, SearchIcon } from '@/components/icons';

export const metadata = { title: 'Sign in' };

/**
 * Standalone auth layout (no app sidebar/search - see AppShell): brand
 * panel on desktop, compact brand header on mobile, Clerk card themed
 * via AuthCard. Error/loading states render inside Clerk's component.
 */
export default function SignInPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl flex-1 lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-center overflow-hidden border-r border-border px-10 lg:flex xl:px-16">
        <div aria-hidden className="mt-projector-glow pointer-events-none absolute inset-0" />
        <div className="mt-enter relative">
          <span className="block w-fit drop-shadow-[0_0_28px_rgba(255,0,51,0.45)]">
            <MegaTubeMark className="h-12 w-12 text-accent" />
          </span>
          <h1 className="mt-5 text-3xl font-bold tracking-tight">
            Mega<span className="text-accent">Tube</span>
          </h1>
          <p className="mt-2 max-w-sm text-[15px] leading-relaxed text-muted">
            Your private video library. Sign in to search, watch, and pick up
            where you left off.
          </p>
          <ul className="mt-8 space-y-4 text-sm">
            {[
              { icon: SearchIcon, text: 'Search across all your MEGA videos' },
              { icon: HistoryIcon, text: 'History and recommendations stay private' },
              { icon: BookmarkIcon, text: 'Watchlists and saved folders on any device' },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-foreground">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-raised text-muted">
                  <Icon className="h-4 w-4" />
                </span>
                {text}
              </li>
            ))}
          </ul>
          {/* Mini marquee card: the library, waiting. */}
          <div aria-hidden className="mt-wall-shadow mt-10 max-w-sm rounded-2xl border border-border bg-surface p-3">
            <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
              <span
                className="absolute inset-0"
                style={{
                  background:
                    'radial-gradient(ellipse 70% 90% at 50% 110%, rgba(255,0,51,0.3), transparent 60%)',
                }}
              />
              <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-accent">
                <PlayIcon className="h-5 w-5 text-white" />
              </span>
              <span className="absolute inset-x-3 bottom-3 block h-1 overflow-hidden rounded-full bg-white/25">
                <span className="block h-full w-1/3 rounded-full bg-accent" />
              </span>
            </div>
            <div className="flex items-center gap-2 px-1 pb-1 pt-3">
              <span className="h-2.5 w-2/3 rounded bg-surface-overlay" />
            </div>
          </div>
        </div>
        <div aria-hidden className="mt-film-edge absolute inset-x-0 bottom-6 h-3 opacity-40" />
      </aside>

      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:py-14">
        <div className="flex w-full max-w-md flex-col items-center">
          <div className="flex flex-col items-center lg:hidden">
            <MegaTubeMark className="h-12 w-12 text-accent" />
            <h1 className="mt-4 text-2xl font-bold tracking-tight">
              Mega<span className="text-accent">Tube</span>
            </h1>
            <p className="mt-1 text-sm text-muted">Your private video library</p>
          </div>
          <div className="mt-8 w-full lg:mt-0">
            <SignInCard />
          </div>
          <p className="mt-6 text-center text-[13px] text-muted">
            New to MegaTube?{' '}
            <Link href="/sign-up" className="font-medium text-accent hover:underline">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
