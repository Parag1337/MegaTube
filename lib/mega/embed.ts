/**
 * MEGA embed URL generation.
 *
 * Transforms a public file link into an embed player URL:
 *
 *   https://mega.nz/file/20oTQTBS#Es81h54-...    (file link)
 *   https://mega.nz/embed/20oTQTBS#Es81h54-...   (embed player)
 *   https://mega.nz/embed/20oTQTBS#Es81h54-...!1a1m  (autoplay + muted)
 *
 * The `!1a1m` suffix asks MEGA to start playback automatically (1a =
 * autoplay) and muted (1m = muted). This is used for hover previews.
 *
 * The file key is passed through untouched - it must not be URL-decoded or
 * re-encoded, as the embed player uses it verbatim.
 */

import { parseMegaUrl } from './parser';

export interface EmbedOptions {
  /** Autoplay the video (`!1a`). */
  autoplay?: boolean;
  /** Start muted (`!1m`). */
  muted?: boolean;
}

/** Normal embed player URL, no autoplay. */
export function generateEmbedUrl(url: string): string {
  const { megaFileId, megaFileKey } = parseMegaUrl(url);
  return `https://mega.nz/embed/${megaFileId}#${megaFileKey}`;
}

/**
 * Non-throwing variant of `generateEmbedUrl`: returns null when the input is
 * not a parseable MEGA public file link. For rendering paths (cards, video
 * pages) so one bad row can never crash a page.
 */
export function tryGenerateEmbedUrl(url: string): string | null {
  try {
    return generateEmbedUrl(url);
  } catch {
    return null;
  }
}

/**
 * Generate an embed URL with playback options.
 *
 * Example with autoplay + muted:
 *   megaFileUrlToEmbedUrl(url, { autoplay: true, muted: true })
 *   => https://mega.nz/embed/FILE_ID#FILE_KEY!1a1m
 */
export function megaFileUrlToEmbedUrl(
  url: string,
  options: EmbedOptions = {},
): string {
  const { megaFileId, megaFileKey } = parseMegaUrl(url);

  let flags = '';
  if (options.autoplay) flags += '1a';
  if (options.muted) flags += '1m';
  const suffix = flags ? `!${flags}` : '';

  return `https://mega.nz/embed/${megaFileId}#${megaFileKey}${suffix}`;
}

/**
 * Non-throwing variant of `megaFileUrlToEmbedUrl`.
 */
export function tryMegaFileUrlToEmbedUrl(
  url: string,
  options: EmbedOptions = {},
): string | null {
  try {
    return megaFileUrlToEmbedUrl(url, options);
  } catch {
    return null;
  }
}

/**
 * Convenience: preview embed URL (autoplay + muted) used for hover/long-press
 * previews on video cards.
 */
export function megaFileUrlToPreviewUrl(url: string): string {
  return megaFileUrlToEmbedUrl(url, { autoplay: true, muted: true });
}

/**
 * Non-throwing variant of `megaFileUrlToPreviewUrl`.
 */
export function tryMegaFileUrlToPreviewUrl(url: string): string | null {
  return tryMegaFileUrlToEmbedUrl(url, { autoplay: true, muted: true });
}