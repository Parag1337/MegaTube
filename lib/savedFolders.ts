/**
 * P2.1 corrections: simple user-created folders organizing Saved Videos.
 *
 * Intentionally minimal: one folder per saved video (nullable folderId),
 * user-scoped by construction, no tagging, no nesting, no sharing.
 *
 * Hard rules:
 *   - folders NEVER come from MEGA folder structure, filenames, creators or
 *     paths - they are only created explicitly by the user;
 *   - deleting a folder NEVER deletes videos and NEVER unsaves them: its
 *     videos return to uncategorized ("All Saved") via SetNull;
 *   - every operation is scoped to (userId + own folder/video rows), so
 *     cross-user access behaves exactly like "not found".
 */

import { prisma } from './db';

export interface SavedFolderRecord {
  id: number;
  name: string;
  createdAt: Date;
  videoCount: number;
}

export const MAX_FOLDER_NAME_LENGTH = 100;

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_FOLDER_NAME_LENGTH) return null;
  return name;
}

/** All folders of a user, oldest first, each with its saved-video count. */
export async function listSavedFolders(userId: string): Promise<SavedFolderRecord[]> {
  const folders = await prisma.savedFolder.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { savedVideos: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    createdAt: f.createdAt,
    videoCount: f._count.savedVideos,
  }));
}

/**
 * Create a folder. Returns null for invalid names, or { duplicate: true }
 * when the user already has a folder with that name (unique per user).
 */
export async function createSavedFolder(
  userId: string,
  rawName: unknown,
): Promise<{ id: number; name: string } | { duplicate: true } | null> {
  const name = cleanName(rawName);
  if (!name) return null;
  try {
    const folder = await prisma.savedFolder.create({
      data: { userId, name },
      select: { id: true, name: true },
    });
    return folder;
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return { duplicate: true };
    }
    throw err;
  }
}

/**
 * Rename a folder. Returns 'ok', 'not-found' (incl. other users' folders),
 * 'invalid' (bad name) or 'duplicate' (name taken by another own folder).
 */
export async function renameSavedFolder(
  userId: string,
  folderId: number,
  rawName: unknown,
): Promise<'ok' | 'not-found' | 'invalid' | 'duplicate'> {
  const name = cleanName(rawName);
  if (!name) return 'invalid';
  try {
    const updated = await prisma.savedFolder.updateMany({
      where: { id: folderId, userId },
      data: { name },
    });
    return updated.count > 0 ? 'ok' : 'not-found';
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return 'duplicate';
    }
    throw err;
  }
}

/**
 * Delete a folder. Its saved videos return to uncategorized (folderId
 * SetNull) - videos are never deleted or unsaved. Returns the number of
 * videos moved back, or null when the folder is not the user's.
 */
export async function deleteSavedFolder(
  userId: string,
  folderId: number,
): Promise<{ movedBack: number } | null> {
  const folder = await prisma.savedFolder.findFirst({
    where: { id: folderId, userId },
    select: { id: true },
  });
  if (!folder) return null;
  const moved = await prisma.savedVideo.updateMany({
    where: { userId, folderId },
    data: { folderId: null },
  });
  await prisma.savedFolder.delete({ where: { id: folderId } });
  return { movedBack: moved.count };
}

/**
 * Move a saved video into a folder (folderId) or back to uncategorized
 * (null). One folder per video. Returns 'ok' or 'not-found' when the saved
 * row - or the target folder - is not the user's. Never auto-saves: the
 * video must already be saved by the user.
 */
export async function moveSavedVideo(
  userId: string,
  videoId: number,
  folderId: number | null,
): Promise<'ok' | 'not-found'> {
  if (folderId !== null) {
    const folder = await prisma.savedFolder.findFirst({
      where: { id: folderId, userId },
      select: { id: true },
    });
    if (!folder) return 'not-found';
  }
  const updated = await prisma.savedVideo.updateMany({
    where: { userId, videoId },
    data: { folderId },
  });
  return updated.count > 0 ? 'ok' : 'not-found';
}
