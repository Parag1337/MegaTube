/**
 * Shared filename -> website-metadata helpers.
 * Used by the MEGA sync engine (private libraries) so derived fields stay
 * consistent.
 */

import { prisma } from './db';

/**
 * Known MEGA download-wrapper suffixes added by tools such as VOE / CDN
 * exporters. These are NOT part of the real title/creator and must be
 * stripped before parsing.
 *
 * The canonical observed form is:
 *   _-_{anything}Video_Cloud.{ext}
 *
 * We strip from the LAST occurrence of a CDN-like suffix so that legitimate
 * trailing text is preserved when possible.
 */
const CDN_SUFFIX_RE = /_-_(?:VOE|CDN|Content_Delivery|Video_Cloud)[^.]*\.[^.]+$/i;

/** Remove download-tool wrappers and the file extension from a MEGA filename. */
function cleanMegaFilename(filename: string): string {
  let cleaned = filename;
  // Strip any path prefix (MEGA filenames should not carry paths, but be
  // defensive: a video is a normal video regardless of folder depth).
  const slash = cleaned.lastIndexOf('/');
  if (slash >= 0) cleaned = cleaned.slice(slash + 1);
  const backslash = cleaned.lastIndexOf('\\');
  if (backslash >= 0) cleaned = cleaned.slice(backslash + 1);
  // Strip CDN wrapper suffix (e.g. "_-_VOE___Content_Delivery_Network_(CDN)___Video_Cloud.mp4").
  cleaned = cleaned.replace(CDN_SUFFIX_RE, '');
  // Strip the "Watch_" prefix added by some download sources.
  if (cleaned.startsWith('Watch_')) cleaned = cleaned.slice(6);
  return cleaned;
}

/** Strip extension and normalize a MEGA filename into a display title. */
export function titleFromFilename(filename: string): string {
  const cleaned = cleanMegaFilename(filename);
  const stem = cleaned.replace(/\.[^.]+$/, '');
  return stem.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface ParsedVideoMetadata {
  /** Creator derived from the filename, or null when the filename has no creator pattern. */
  creator: string | null;
  /** Display title (extension stripped). Never a node-id fallback. */
  title: string;
}

/**
 * Derive (creator, title) from a real MEGA filename.
 *
 * The filename is the source of truth. Folders, paths and node IDs are
 * deliberately ignored: a video is a normal video wherever it lives in the
 * MEGA tree.
 *
 * Before parsing, download-tool wrappers (CDN suffixes, "Watch_" prefix) are
 * stripped so they never leak into the title or creator.
 *
 * Conventions supported, in priority order:
 *   1. "Creator Name - Video Title.mp4"   (spaced " - " delimiter)
 *   2. "Creator_Name_-_Video_Title.mp4"   (site underscore convention)
 *   3. no delimiter                       -> title only, creator stays null
 *
 * Only the file extension is removed from the title. Nothing is invented:
 * when no creator pattern matches, creator is null (the UI shows its own
 * "Unknown Creator" fallback).
 */
export function parseVideoMetadata(filename: string): ParsedVideoMetadata {
  const cleaned = cleanMegaFilename(filename);
  const stem = cleaned.replace(/\.[^.]+$/, '');

  // 1) Spaced " - " delimiter: everything before the FIRST delimiter is the
  //    creator, everything after it is the title (remaining delimiters stay
  //    part of the title).
  const spaced = stem.indexOf(' - ');
  if (spaced > 0) {
    const creator = stem.slice(0, spaced).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    const title = stem.slice(spaced + 3).replace(/\s+/g, ' ').trim();
    if (creator && title) return { creator, title };
  }

  // 2) Underscore convention "Creator_-_Title" (also tolerate en/em dashes).
  const under = stem.indexOf('_-_');
  if (under > 0) {
    const creator = stem.slice(0, under).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    const title = stem.slice(under + 3).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    if (creator && title) return { creator, title };
  }

  // 3) No creator pattern: keep the filename-derived title, invent nothing.
  return { creator: null, title: titleFromFilename(filename) };
}

/** Slugify any string (lowercase, kebab-case, ASCII-only). */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'video';
}

/**
 * Best-effort creator guess from the MEGA filename.
 *
 * Common site convention: "CreatorName_-_Title" or "_CreatorName__Title".
 * Falls back to null (caller uses "Unknown Creator").
 */
export function guessCreatorFromFilename(filename: string): string | null {
  const stem = filename.replace(/\.[^.]+$/, '');

  // "Creator_-_Title" (also tolerate en/em dashes)
  let m = stem.match(/^_?([^_]+(?:[ _][^_]+)*?)_[–—-]\s*/);
  if (m) return m[1].trim();

  // "_Creator__Title"
  m = stem.match(/^_([^_]+(?:[ _][^_]+)*?)__/);
  if (m) return m[1].trim();

  return null;
}

const KNOWN_GENERIC_PREFIXES = /^(joi|bbc|hot[_ ]girl[_ ]joi|pov)[\s_\-–—]*/i;

export function normalizeCreatorName(name: string): string {
  const cleaned = name.replace(KNOWN_GENERIC_PREFIXES, '').trim();
  const spaced = cleaned.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced || 'Unknown Creator';
}

export async function slugExists(slug: string): Promise<boolean> {
  const found = await prisma.video.findUnique({ where: { slug }, select: { id: true } });
  return Boolean(found);
}

export async function uniqueSlug(base: string): Promise<string> {
  let slug = slugify(base);
  let n = 2;
  while (await slugExists(slug)) {
    slug = `${slugify(base)}-${n++}`;
  }
  return slug;
}

export async function findCreatorIdForUser(
  userId: string,
  normalizedName: string,
): Promise<number | null> {
  const slug = slugify(normalizedName);
  const creator = await prisma.creator.findFirst({
    where: { userId, slug },
    select: { id: true },
  });
  return creator?.id ?? null;
}

export async function ensureCreatorForUser(
  userId: string,
  rawName: string,
): Promise<number> {
  const normalized = normalizeCreatorName(rawName);
  const slug = slugify(normalized);
  const existing = await prisma.creator.findFirst({
    where: { userId, slug },
    select: { id: true },
  });
  if (existing) return existing.id;

  return prisma.creator.create({
    data: {
      userId,
      name: normalized,
      slug,
    },
  }).then((c) => c.id);
}
