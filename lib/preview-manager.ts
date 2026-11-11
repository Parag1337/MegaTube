/**
 * Client-side preview manager.
 *
 * Two responsibilities:
 *
 * 1. At-most-one active preview. A card that starts a preview calls
 *    `acquirePreview`, which stops any previously active preview before
 *    activating the new one. Without this, hovering quickly across a grid
 *    could leave several videos playing at once.
 *
 * 2. Mobile visibility election. Touch devices have no hover, so cards
 *    report how much of themselves is visible; the most prominent candidate
 *    is the only one allowed to auto-play. Cards are only reported after
 *    their own dwell timer has elapsed, so fast scrolling never starts
 *    previews.
 */

type StopFn = () => void;

let activeStop: StopFn | null = null;

/**
 * Register this card's stop function as the active preview.
 * Any previously active preview is stopped first (at most one preview
 * exists at any moment).
 */
export function acquirePreview(stop: StopFn): void {
  if (activeStop && activeStop !== stop) {
    activeStop();
  }
  activeStop = stop;
}

/** Release the slot if this card owns it. */
export function releasePreview(stop: StopFn): void {
  if (activeStop === stop) {
    activeStop = null;
  }
}

export interface MobileCandidateHandlers {
  activate: () => void;
  deactivate: () => void;
}

const mobileCandidates = new Map<string, { ratio: number; handlers: MobileCandidateHandlers }>();
let mobileActiveId: string | null = null;

/** Lowest visibility ratio that may auto-play on a touch device. */
export const MOBILE_VISIBILITY_THRESHOLD = 0.6;

/**
 * Report (or update) this card's visibility ratio. Only candidates at or
 * above the threshold are eligible; the highest ratio wins and any previous
 * winner is stopped before the new one starts.
 */
export function reportMobileVisibility(
  id: string,
  ratio: number,
  handlers: MobileCandidateHandlers,
): void {
  if (ratio >= MOBILE_VISIBILITY_THRESHOLD) {
    mobileCandidates.set(id, { ratio, handlers });
    electMobileCandidate();
    return;
  }
  // Falling below the threshold stops this card if it currently plays.
  const wasActive = mobileActiveId === id;
  mobileCandidates.delete(id);
  if (wasActive) {
    mobileActiveId = null;
    handlers.deactivate();
  }
  electMobileCandidate();
}

/** Stop reporting visibility (scrolled out, unmounted, or no longer mobile). */
export function removeMobileCandidate(id: string): void {
  const candidate = mobileCandidates.get(id);
  const wasActive = mobileActiveId === id;
  mobileCandidates.delete(id);
  if (wasActive) {
    mobileActiveId = null;
    candidate?.handlers.deactivate();
  }
  electMobileCandidate();
}

function electMobileCandidate(): void {
  let bestId: string | null = null;
  let bestRatio = MOBILE_VISIBILITY_THRESHOLD;
  for (const [id, candidate] of mobileCandidates) {
    // `>=` keeps the first-reported card on ties instead of thrashing.
    if (candidate.ratio >= bestRatio) {
      bestRatio = candidate.ratio;
      bestId = id;
    }
  }

  if (bestId === mobileActiveId) return;

  const previous = mobileActiveId ? mobileCandidates.get(mobileActiveId) : undefined;
  mobileActiveId = bestId;
  if (previous) previous.handlers.deactivate();
  if (bestId) mobileCandidates.get(bestId)?.handlers.activate();
}

/** Test hook: clear all coordinator state. */
export function __resetPreviewManagerForTests(): void {
  activeStop = null;
  mobileCandidates.clear();
  mobileActiveId = null;
}
