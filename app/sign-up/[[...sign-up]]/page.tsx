import Link from 'next/link';
import { SignUpCard } from '@/components/AuthCard';
import { AccountIcon, LibraryIcon, MegaTubeMark, PlayIcon } from '@/components/icons';

export const metadata = { title: 'Sign up' };

/**
 * Standalone auth layout (no app sidebar/search - see AppShell): brand
 * panel on desktop, compact brand header on mobile, Clerk card themed
 * via AuthCard. Error/loading states render inside Clerk's component.
 */
export default function SignUpPage() {
  return (
    <div className="mx-auto grid w-full max-w-6xl flex-1 lg:min-h-[calc(100vh-3.5rem-1px)] lg:grid-cols-2 lg:content-center">
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
            Create your account, connect a MEGA account, and turn scattered
            files into a library worth browsing.
          </p>
          <ol className="mt-8 space-y-4 text-sm">
            {[
              { icon: AccountIcon, text: '1. Create your MegaTube account' },
              { icon: LibraryIcon, text: '2. Connect MEGA and sync your videos' },
              { icon: PlayIcon, text: '3. Search, watch, and save' },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-foreground">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-raised text-muted">
                  <Icon className="h-4 w-4" />
                </span>
                {text}
              </li>
            ))}
          </ol>
          {/* Mini marquee card: the library, waiting. */}
          <div aria-hidden className="mt-wall-shadow mt-10 max-w-sm rounded-2xl border border-border bg-surface p-3">
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="relative aspect-video overflow-hidden rounded-lg bg-surface-raised">
                  <span
                    className="absolute inset-0"
                    style={{
                      background:
                        i === 1
                          ? 'radial-gradient(circle at 50% 80%, rgba(255,0,51,0.3), transparent 65%)'
                          : 'none',
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 px-1 pb-1 pt-3">
              <span className="h-2.5 w-1/2 rounded bg-surface-overlay" />
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
            <SignUpCard />
          </div>
          <p className="mt-6 text-center text-[13px] text-muted">
            Already have an account?{' '}
            <Link href="/sign-in" className="font-medium text-accent hover:underline">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
