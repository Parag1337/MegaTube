'use client';

import { useTheme, type ThemeChoice } from '@/components/ThemeProvider';

/**
 * Appearance preference control: System / Light / Dark. Persists via
 * ThemeProvider (localStorage `megatube.theme`) and applies as
 * `html[data-theme]` across landing, app, cards, and dialogs.
 */
const OPTIONS: Array<{ value: ThemeChoice; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Follow your device' },
  { value: 'light', label: 'Light', hint: 'Paper surfaces' },
  { value: 'dark', label: 'Dark', hint: 'Screening room' },
];

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="grid grid-cols-3 gap-2"
    >
      {OPTIONS.map((opt) => {
        const selected = theme === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setTheme(opt.value)}
            className={`rounded-2xl border p-3 text-left transition-colors sm:p-4 ${
              selected
                ? 'border-accent bg-accent-soft'
                : 'border-border bg-surface-raised hover:border-border-light'
            }`}
          >
            {/* Mini theme preview swatch */}
            <span
              aria-hidden
              className={`mb-2 flex h-10 overflow-hidden rounded-lg border ${
                opt.value === 'light'
                  ? 'border-[#e4e4e7]'
                  : opt.value === 'dark'
                    ? 'border-[#262626]'
                    : 'border-border'
              }`}
            >
              <span
                className={`h-full flex-1 ${opt.value === 'dark' ? 'bg-[#0f0f0f]' : 'bg-[#fafafa]'}`}
              />
              <span
                className={`h-full flex-1 ${opt.value === 'light' ? 'bg-[#fafafa]' : 'bg-[#0f0f0f]'}`}
              />
            </span>
            <span className="block text-sm font-medium text-foreground">{opt.label}</span>
            <span className="mt-0.5 block text-xs text-muted">{opt.hint}</span>
          </button>
        );
      })}
    </div>
  );
}
