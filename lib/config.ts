/** Site-wide configuration. */

export const SITE_NAME = 'MegaTube';

export function videosPerPage(): number {
  const n = Number(process.env.VIDEOS_PER_PAGE);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 96) : 24;
}

export function previewDelayMs(): number {
  const n = Number(process.env.PREVIEW_DELAY_MS);
  return Number.isFinite(n) && n > 0 ? n : 400;
}