/**
 * Thumbnail display rule (single source of truth, pure function):
 *
 * - approximately 16:9  -> show the whole frame (object-contain)
 * - anything else        -> fill the 16:9 card (object-cover, crop OK)
 *
 * The browser supplies naturalWidth/naturalHeight on load; no image
 * pipeline, no analysis, no second layer.
 */

const SIXTEEN_BY_NINE = 16 / 9;

/** Aspect ratios within this distance of 16:9 count as 16:9. */
export const WIDESCREEN_TOLERANCE = 0.1;

export function isApproximatelySixteenByNine(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  return Math.abs(width / height - SIXTEEN_BY_NINE) <= WIDESCREEN_TOLERANCE;
}
