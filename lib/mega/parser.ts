/**
 * MEGA public link parsing.
 *
 * Only the standard public file link format is supported:
 *
 *   https://mega.nz/file/FILE_ID#FILE_KEY
 *
 * FILE_ID is an 8-character base64url handle, FILE_KEY is a base64url
 * string. We never log or expose the key beyond what is needed to build
 * embed URLs (the embed player requires it).
 */

export interface MegaFileLink {
  /** Raw URL as provided (normalized). */
  url: string;
  /** 8-character MEGA file handle, e.g. "20oTQTBS". */
  megaFileId: string;
  /** base64url MEGA file key, e.g. "Es81h54-...". */
  megaFileKey: string;
}

const MEGA_FILE_URL_RE =
  /^https?:\/\/(?:www\.)?mega\.(?:nz|co\.nz)\/file\/([A-Za-z0-9_-]{8})#([A-Za-z0-9_-]{32,64})$/;

const FILE_ID_RE = /^[A-Za-z0-9_-]{8}$/;
const FILE_KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;

/**
 * Parse a MEGA public file link into its parts.
 *
 * @throws {Error} if the URL is not a supported MEGA public file link.
 */
export function parseMegaUrl(input: string): MegaFileLink {
  if (typeof input !== 'string') {
    throw new Error('MEGA link must be a string');
  }

  const url = input.trim();

  const match = url.match(MEGA_FILE_URL_RE);
  if (!match) {
    throw new Error(
      'Unsupported MEGA link. Expected format: https://mega.nz/file/FILE_ID#FILE_KEY',
    );
  }

  const megaFileId = match[1];
  const megaFileKey = match[2];

  // Double-check parts in case the host regex was relaxed.
  if (!FILE_ID_RE.test(megaFileId) || !FILE_KEY_RE.test(megaFileKey)) {
    throw new Error('Invalid MEGA file id or key in link');
  }

  return { url, megaFileId, megaFileKey };
}

/**
 * Validate a MEGA file id/key pair without throwing.
 * Returns an error message, or null if valid.
 */
export function validateMegaUrl(input: string): string | null {
  try {
    parseMegaUrl(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** True if the string looks like a supported MEGA public file link. */
export function isMegaFileUrl(input: string): boolean {
  return MEGA_FILE_URL_RE.test(input.trim());
}