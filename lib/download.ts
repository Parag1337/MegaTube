/**
 * Download helpers: filename sanitization, source MIME mapping,
 * Content-Disposition building, and a bounded-concurrency pool.
 *
 * All pure (no prisma, no MEGA, no network) so they are unit-testable.
 * The route wires them to the existing MEGA session/decrypt/stream
 * pipeline in app/api/download/[videoId]/route.ts.
 */

/** Fallback filename when nothing usable is stored (never empty). */
export const FALLBACK_DOWNLOAD_FILENAME = 'video.bin';

/** Max filename length (bytes-ish, conservative for filesystems + headers). */
export const MAX_DOWNLOAD_FILENAME_LENGTH = 180;

/** Characters illegal on Windows/macOS + path separators + controls. */
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Sanitize a filename for Content-Disposition + disk safety:
 * - strips path components (no traversal: "a/b", "..", "C:\");
 * - removes illegal filesystem characters and control chars (incl. CR/LF,
 *   so header injection is impossible);
 * - trims trailing dots/spaces (Windows-unfriendly);
 * - preserves the original extension;
 * - caps length, keeping the extension intact;
 * - falls back to a title-derived name, then to video.bin.
 */
export function sanitizeDownloadFilename(
  raw: string | null | undefined,
  fallbackTitle?: string | null,
  fallbackExt?: string | null,
): string {
  const cleaned = cleanName(raw);
  if (cleaned) return truncateWithExt(cleaned);
  const fromTitle = cleanName(fallbackTitle);
  if (fromTitle) {
    const ext = normalizeExt(fallbackExt);
    return truncateWithExt(ext && !hasExt(fromTitle) ? `${fromTitle}${ext}` : fromTitle);
  }
  return FALLBACK_DOWNLOAD_FILENAME;
}

function cleanName(raw: string | null | undefined): string {
  if (!raw) return '';
  // Take only the last path segment (kills "a/b", "..", "C:\x").
  const base = String(raw).split(/[\\/]/).pop() ?? '';
  const name = base
    .replace(UNSAFE_FILENAME_CHARS, '')
    .replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202f\ufeff]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .replace(/[. ]+$/, '');
  // A name that is only dots/empties is unsafe - reject it.
  if (!name || /^[.]+$/.test(name)) return '';
  return name;
}

function hasExt(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 && name.length - dot - 1 <= 10;
}

function normalizeExt(ext: string | null | undefined): string {
  if (!ext) return '';
  const e = ext.trim().toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9]/g, '');
  if (!e || e.length > 10) return '';
  return `.${e}`;
}

function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1 && name.length - dot - 1 <= 10) {
    return { stem: name.slice(0, dot), ext: name.slice(dot) };
  }
  return { stem: name, ext: '' };
}

function truncateWithExt(name: string): string {
  if (name.length <= MAX_DOWNLOAD_FILENAME_LENGTH) return name;
  const { stem, ext } = splitExt(name);
  const keep = Math.max(1, MAX_DOWNLOAD_FILENAME_LENGTH - ext.length);
  return `${stem.slice(0, keep)}${ext}`;
}

/** Extension -> source MIME for original MEGA files (download, not playback). */
const EXTENSION_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  m2ts: 'video/mp2t',
  mts: 'video/mp2t',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

/** Extension used when only a MIME type is known (title-derived fallback). */
const MIME_EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
};

/**
 * Appropriate Content-Type for an ORIGINAL source file: the stored MIME
 * when it looks sane, otherwise the extension map, otherwise
 * application/octet-stream. Never throws.
 */
export function mimeTypeForDownload(
  storedMime: string | null | undefined,
  filename: string,
): string {
  const stored = (storedMime ?? '').trim().toLowerCase();
  if (/^(video|audio)\/[a-z0-9.+-]+$/.test(stored)) return stored;
  const dot = filename.lastIndexOf('.');
  if (dot >= 0) {
    const mapped = EXTENSION_MIME[filename.slice(dot + 1).toLowerCase()];
    if (mapped) return mapped;
  }
  return 'application/octet-stream';
}

/** Extension (with dot) for a MIME type, '' when unknown. */
export function extensionForMimeType(mime: string | null | undefined): string {
  if (!mime) return '';
  return MIME_EXTENSION[mime.trim().toLowerCase()] ?? '';
}

/**
 * RFC 6266/5987 Content-Disposition for an attachment:
 * - ASCII-safe names use the plain `filename="..."` form;
 * - anything else also carries `filename*=UTF-8''...` (percent-encoded).
 * The name must already be sanitized (no quotes/backslash/CR/LF survive
 * sanitizeDownloadFilename, but we escape defensively anyway).
 */
export function buildContentDisposition(filename: string): string {
  const safe = filename.replace(/\\/g, '').replace(/"/g, '');
  if (/^[\x20-\x7e]*$/.test(safe) && safe.length > 0) {
    return `attachment; filename="${safe}"`;
  }
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------------------------------------------------------------------
// Bounded concurrency pool (Download All queue).
// ---------------------------------------------------------------------------

export interface BoundedRunResult<T> {
  completed: T[];
  failed: Array<{ item: T; error: string }>;
  /** Highest number of workers observed running at once (test hook). */
  maxActive: number;
}

/**
 * Run `fn` over `items` with at most `limit` workers at once.
 * - one item failing never aborts the rest (recorded in `failed`);
 * - results keep input order within completed/failed;
 * - empty input resolves immediately; limit is clamped to >= 1.
 */
export async function runBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<BoundedRunResult<T>> {
  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  const completed: T[] = [];
  const failed: Array<{ item: T; error: string }> = [];
  let next = 0;
  let active = 0;
  let maxActive = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      active++;
      if (active > maxActive) maxActive = active;
      try {
        await fn(item, index);
        completed.push(item);
      } catch (err) {
        failed.push({
          item,
          error: err instanceof Error ? err.message : String(err ?? 'failed'),
        });
      } finally {
        active--;
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(safeLimit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return { completed, failed, maxActive };
}
