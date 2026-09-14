import Link from 'next/link';
import { SITE_NAME } from '@/lib/config';
import { HeroMediaWall } from '@/components/HeroMediaWall';
import { Reveal } from '@/components/Reveal';
import {
  AccountIcon,
  BookmarkIcon,
  CreatorsIcon,
  HistoryIcon,
  LibraryIcon,
  MegaTubeMark,
  PlayIcon,
  SearchIcon,
} from '@/components/icons';

/**
 * Logged-out MegaTube landing page. Visual direction: "screening
 * room" - auditorium ink, one projector glow, film-strip and marquee
 * vernacular, a pointer-responsive media wall as the single bold
 * moment. Every claim maps to a real capability; no metrics, no
 * testimonials, no invented integrations.
 */
export function Landing() {
  return (
    <div>
      {/* ------------------------------------------------ Hero ------- */}
      <section className="relative overflow-hidden border-b border-border lg:flex lg:min-h-[calc(100vh-3.5rem)] lg:flex-col lg:justify-center">
        <div aria-hidden className="mt-projector-glow pointer-events-none absolute inset-0" />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pb-20 pt-12 sm:pt-16 lg:grid-cols-[1fr_1.1fr] lg:gap-8 lg:px-6 lg:pb-24 lg:pt-20">
          <div className="mt-enter" style={{ '--enter-delay': '0ms' } as React.CSSProperties}>
            <p className="flex w-fit items-center gap-2 rounded-full border border-border bg-surface py-1 pl-3 pr-4 text-xs font-medium text-muted">
              <span aria-hidden className="mt-rec h-1.5 w-1.5 rounded-full bg-accent" />
              Private video library for MEGA
            </p>
            <h1 className="mt-5 text-4xl font-bold leading-[1.04] tracking-tight text-foreground sm:text-5xl lg:text-[3.4rem]">
              Your MEGA files, showing nightly.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-muted">
              {SITE_NAME} connects to your MEGA accounts and turns scattered
              files into a real video library - searchable, organized by
              creator, and ready to play in the browser.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Link
                href="/sign-up"
                className="inline-flex h-11 items-center rounded-full bg-accent px-6 text-sm font-medium text-white transition-all hover:-translate-y-px hover:bg-accent-hover hover:shadow-[0_8px_28px_-8px_rgba(255,0,51,0.6)]"
              >
                Get started
              </Link>
              <Link
                href="/sign-in"
                className="inline-flex h-11 items-center rounded-full border border-border bg-surface px-6 text-sm font-medium text-foreground transition-colors hover:border-border-light hover:bg-surface-hover"
              >
                Sign in
              </Link>
            </div>
            <p className="mt-4 text-[13px] text-muted">
              Your files stay on MEGA. {SITE_NAME} only reads what you connect.
            </p>
          </div>

          <HeroMediaWall />
        </div>
      </section>

      {/* ----------------------------------------- Film strip --------- */}
      <section aria-label="What you get" className="overflow-hidden border-b border-border bg-surface">
        <div className="mx-auto max-w-6xl px-4 pb-4 pt-12 lg:px-6 lg:pt-16">
          <Reveal>
            <h2 className="max-w-xl text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              One sync. Every video, findable.
            </h2>
            <p className="mt-3 max-w-lg text-[15px] leading-relaxed text-muted">
              Each frame below is something your library actually does once
              your MEGA accounts finish syncing.
            </p>
          </Reveal>
        </div>
        <Reveal delay={120}>
          <div className="mt-8 pb-12 lg:pb-16">
            <div aria-hidden className="mt-film-edge h-3 opacity-60" />
            <div className="overflow-x-auto border-y border-border bg-background">
              <ul className="flex min-w-max gap-0 px-4 py-5 lg:justify-center lg:px-6">
                {[
                  { icon: SearchIcon, title: 'Search', body: 'Titles and filenames, instantly' },
                  { icon: CreatorsIcon, title: 'Creators', body: 'Guessed from filenames, editable' },
                  { icon: HistoryIcon, title: 'History', body: 'Private watch record' },
                  { icon: BookmarkIcon, title: 'Watchlist', body: 'Bookmark for later' },
                  { icon: LibraryIcon, title: 'Folders', body: 'Saved videos, organized' },
                  { icon: AccountIcon, title: 'Accounts', body: 'Several MEGAs, one library' },
                ].map(({ icon: Icon, title, body }, i) => (
                  <li
                    key={title}
                    className={`w-44 shrink-0 px-4 ${i > 0 ? 'border-l border-border' : ''}`}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-raised text-muted">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <p className="mt-3 text-sm font-semibold text-foreground">{title}</p>
                    <p className="mt-1 text-[13px] leading-snug text-muted">{body}</p>
                  </li>
                ))}
              </ul>
            </div>
            <div aria-hidden className="mt-film-edge h-3 opacity-60" />
          </div>
        </Reveal>
      </section>

      {/* ------------------------------------ Player + library ------- */}
      <section className="border-b border-border">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 lg:grid-cols-2 lg:gap-16 lg:px-6 lg:py-24">
          <Reveal>
            <p className="text-[13px] font-medium text-accent">Playback</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              A player that knows your library.
            </h2>
            <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">
              Every video page pairs the player with context. Formats browsers
              can&apos;t play directly are remuxed on the fly, so playback
              just starts - then Up Next keeps it going.
            </p>
            <ul className="mt-7 space-y-1">
              {[
                { title: 'Up Next, beside the player', body: 'Title matches first, then same-creator picks' },
                { title: 'From this creator, below', body: 'A mixed rail of creator, title, and discovery picks' },
                { title: 'Resume where you left off', body: 'Playback position is remembered per video' },
              ].map(({ title, body }) => (
                <li
                  key={title}
                  className="group flex gap-4 rounded-2xl border border-transparent p-3 transition-colors hover:border-border hover:bg-surface"
                >
                  <span aria-hidden className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent transition-colors group-hover:bg-accent group-hover:text-white">
                    <PlayIcon className="h-3.5 w-3.5" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-foreground">{title}</span>
                    <span className="mt-0.5 block text-[13px] text-muted">{body}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Reveal>
          {/* Up-next mock: editorial list, not another grid */}
          <Reveal delay={140} className="w-full">
            <div aria-hidden className="mt-wall-shadow select-none rounded-2xl border border-border bg-surface p-4 sm:p-5">
              <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-black">
                <span
                  className="absolute inset-0"
                  style={{
                    background:
                      'radial-gradient(ellipse 70% 90% at 50% 110%, rgba(255,0,51,0.25), transparent 60%)',
                  }}
                />
                <span className="relative flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
                  <PlayIcon className="h-5 w-5 text-white" />
                </span>
                <span className="absolute inset-x-3 bottom-3 block h-1 overflow-hidden rounded-full bg-white/25">
                  <span className="block h-full w-2/3 rounded-full bg-accent" />
                </span>
              </div>
              <p className="px-1 pb-1 pt-4 text-xs font-semibold tracking-wide text-muted">UP NEXT</p>
              <ul className="space-y-1">
                {[
                  { t: 'Midnight drive (official video)', d: '04:17', w: 'w-4/5' },
                  { t: 'Studio session, take three', d: '22:31', w: 'w-3/5' },
                  { t: 'Live at the harbor, full set', d: '1:04:12', w: 'w-2/3' },
                ].map(({ t, d, w }) => (
                  <li key={t} className="flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-surface-hover">
                    <span className="h-12 w-20 shrink-0 rounded-lg bg-surface-raised" />
                    <span className="min-w-0 flex-1">
                      <span className={`block h-2.5 rounded bg-surface-overlay ${w}`} />
                      <span className="mt-1.5 block h-2 w-1/4 rounded bg-surface-overlay" />
                    </span>
                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted">{d}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------ Marquee ---------- */}
      <div aria-hidden className="overflow-hidden border-b border-border py-5 select-none">
        <div className="mt-marquee-track flex w-max whitespace-nowrap">
          {[0, 1].map((half) => (
            <p key={half} className="flex shrink-0 items-center">
              {Array.from({ length: 4 }).map((_, i) => (
                <span key={i} className="flex items-center">
                  <span className="px-6 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
                    Your collection
                  </span>
                  <span className="mt-outline-text px-2 text-2xl font-bold tracking-tight sm:text-3xl">
                    on the marquee
                  </span>
                  <span className="mx-2 h-2 w-2 rounded-full bg-accent" />
                </span>
              ))}
            </p>
          ))}
        </div>
      </div>

      {/* ----------------------------------------- How it works ------ */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 py-14 lg:px-6 lg:py-24">
          <Reveal>
            <p className="text-[13px] font-medium text-accent">Getting started</p>
            <h2 className="mt-2 max-w-lg text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              From scattered files to showtime in three steps.
            </h2>
          </Reveal>
          <ol className="mt-10 grid gap-8 md:grid-cols-3 md:gap-6">
            {[
              {
                step: '01',
                title: 'Create your account',
                body: 'Sign up in seconds. Your MegaTube account holds the library index - never your MEGA password.',
              },
              {
                step: '02',
                title: 'Connect MEGA and sync',
                body: 'Link one or more MEGA accounts from your Account page and run a sync to index your videos.',
              },
              {
                step: '03',
                title: 'Search and watch',
                body: 'Browse Home, follow creators, save to folders, and pick up where you left off on any device.',
              },
            ].map(({ step, title, body }, i) => (
              <Reveal as="li" key={step} delay={i * 110} className="relative list-none border-t-2 border-border pt-5">
                <span aria-hidden className="text-sm font-bold tabular-nums text-accent">{step}</span>
                <h3 className="mt-2 text-base font-semibold text-foreground">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ----------------------------------------------- Final CTA --- */}
      <section className="relative overflow-hidden">
        <div aria-hidden className="mt-projector-glow pointer-events-none absolute inset-0" />
        <Reveal className="relative mx-auto max-w-6xl px-4 py-16 text-center lg:px-6 lg:py-24">
          <span aria-hidden className="mx-auto block w-fit drop-shadow-[0_0_36px_rgba(255,0,51,0.45)]">
            <MegaTubeMark className="h-14 w-14 text-accent" />
          </span>
          <h2 className="mx-auto mt-6 max-w-xl text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Roll credits on the file browser.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted">
            Set up your private library in minutes. Free, and nothing to upload.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/sign-up"
              className="inline-flex h-12 items-center rounded-full bg-accent px-8 text-sm font-medium text-white transition-all hover:-translate-y-px hover:bg-accent-hover hover:shadow-[0_8px_28px_-8px_rgba(255,0,51,0.6)]"
            >
              Get started
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex h-12 items-center rounded-full border border-border bg-surface px-8 text-sm font-medium text-foreground transition-colors hover:border-border-light hover:bg-surface-hover"
            >
              Sign in
            </Link>
          </div>
        </Reveal>
      </section>

      {/* -------------------------------------------------- Footer --- */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row lg:px-6">
          <p className="flex items-center gap-2 text-sm font-bold tracking-tight text-foreground">
            <MegaTubeMark className="h-6 w-6 text-accent" />
            Mega<span className="-ml-2 text-accent">Tube</span>
          </p>
          <nav aria-label="Footer" className="flex items-center gap-5 text-sm text-muted">
            <Link href="/sign-in" className="transition-colors hover:text-foreground">
              Sign in
            </Link>
            <Link href="/sign-up" className="transition-colors hover:text-foreground">
              Get started
            </Link>
          </nav>
          <p className="text-[13px] text-muted">Your private video library.</p>
        </div>
      </footer>
    </div>
  );
}
