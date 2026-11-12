/**
 * Phase 5.1: server-side authorization for the preview-administration routes.
 *
 * MegaTube stores one private library per user, so the library owner is the
 * administrator of their own preview jobs. Authentication alone is therefore
 * the baseline gate — every query below is additionally scoped by `userId`,
 * so a signed-in user can never inspect or trigger work on another user's
 * videos.
 *
 * Deployments that want a narrower operator list can set
 * PREVIEW_ADMIN_EMAILS (comma-separated). When it is set, only those email
 * addresses may use the administrative routes. When it is unset (the normal
 * single-owner deployment), every authenticated owner manages their library.
 *
 * This check must run in the route handler, not only in the UI.
 */

import type { UserRecord } from '../auth';

export function previewAdminEmails(): string[] {
  const raw = process.env.PREVIEW_ADMIN_EMAILS ?? '';
  return raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

/** True when this authenticated user may manage preview generation. */
export function canManagePreviews(user: UserRecord | null): user is UserRecord {
  if (!user) return false;
  const allow = previewAdminEmails();
  if (allow.length === 0) return true;
  return allow.includes(user.email.trim().toLowerCase());
}
