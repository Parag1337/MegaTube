/**
 * Client-side preview manager.
 *
 * Enforces the "at most one preview iframe at a time" rule: when a card
 * starts a preview it calls `acquirePreview`, which stops any previously
 * active preview before activating the new one.
 */

type StopFn = () => void;

let activeStop: StopFn | null = null;

/**
 * Register this card's stop function as the active preview.
 * Any previously active preview is stopped first (at most one preview
 * iframe exists at any moment).
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