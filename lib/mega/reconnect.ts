/**
 * Explicit user-driven MEGA reconnection (Phase 2).
 *
 * This is the orchestration behind the ONLY operation in the application that
 * accepts MEGA credentials (besides initial linking): the user-visible
 * "Reconnect MEGA" action for an account whose stored session is no longer
 * usable (status REAUTH_REQUIRED).
 *
 * Flow (all steps or none):
 *   1. load the account OWNED BY the requesting website user (IDOR-safe)
 *   2. require status REAUTH_REQUIRED (reconnect is never a side effect of
 *      page loads, the scheduler, or Sync Now - those paths never call this)
 *   3. MEGA login with the password (+ MFA code when the account requires
 *      one). The password exists only for the duration of this call, is used
 *      exactly once by megajs, and is never stored, logged, or returned.
 *   4. capture reusable session material (sid + master key + RSA private key)
 *   5. verify the material is resumable via the password-less session path
 *      (openMegaSession + one read-only a=ug) BEFORE claiming success
 *   6. persist ONLY the AES-256-GCM-encrypted material
 *      (MEGA_SESSION_ENCRYPTION_KEY envelope, see lib/mega/envelope.ts)
 *   7. only after persistence succeeded: status = CONNECTED, stale auth
 *      errors cleared
 *
 * Failure at ANY step leaves the account REAUTH_REQUIRED with its previous
 * (encrypted) material untouched. No synchronization is started here.
 *
 * The MEGA deps (login / verify) are injectable so unit tests can mock the
 * network boundary without ever touching the real MEGA API.
 */

import {
  loginToMega,
  verifyStoredSession,
  closeMegaSession,
  MegaError,
} from './account';
import type { MegaSessionMaterial, SessionResumeCheck } from './account';
import {
  getMegaAccountForUser,
  replaceMegaAccountSession,
  markAccountConnected,
  MEGA_ACCOUNT_STATUSES,
} from '../megaAccounts';
import { hasEnvelopeKey, MegaConfigError } from './envelope';
import { evictMegaSession } from '../sync/session-cache';

export type ReconnectFailureReason =
  | 'missing-password'
  | 'not-found'
  | 'wrong-status'
  | 'mfa'
  | 'auth-failed'
  | 'transient'
  | 'identity-mismatch'
  | 'session-verify-failed'
  | 'not-configured'
  | 'persist-failed'
  | 'unexpected';

export type ReconnectOutcome =
  | { ok: true }
  | { ok: false; reason: ReconnectFailureReason; message: string };

/**
 * Safe, user-presentable error responses (HTTP status + message) per failure
 * reason. Messages never contain credentials, session material, or raw MEGA
 * API error text.
 */
export const RECONNECT_ERROR_RESPONSES: Record<
  ReconnectFailureReason,
  { status: number; message: string }
> = {
  'missing-password': {
    status: 400,
    message: 'Enter your MEGA account password to reconnect.',
  },
  'not-found': { status: 404, message: 'Account not found.' },
  'wrong-status': {
    status: 409,
    message: 'This account does not currently need reconnection.',
  },
  mfa: {
    status: 401,
    message: 'This MEGA account requires a 2FA code. Enter it and try again.',
  },
  'auth-failed': {
    status: 401,
    message: 'MEGA login failed. Check the password for this MEGA account.',
  },
  transient: {
    status: 502,
    message: 'MEGA is temporarily unavailable. Please try again in a moment.',
  },
  'identity-mismatch': {
    status: 409,
    message: 'MEGA returned a different account identity than the linked one.',
  },
  'session-verify-failed': {
    status: 502,
    message: 'MEGA accepted the login but the session could not be established. Try again.',
  },
  'not-configured': {
    status: 500,
    message: 'MEGA linking is not configured on this server.',
  },
  'persist-failed': {
    status: 500,
    message: 'The MEGA session could not be saved. Please try reconnecting again.',
  },
  unexpected: { status: 500, message: 'Something went wrong.' },
};

/**
 * Injectable boundary (tests pass fakes here; production uses the defaults).
 * `login`/`verify` are the MEGA network boundary; `persist`/`markConnected`
 * are the DB write steps (injectable so tests can prove CONNECTED is never
 * claimed before persistence succeeds, and in what order the writes happen).
 */
export interface ReconnectDeps {
  login: typeof loginToMega;
  verify: typeof verifyStoredSession;
  persist: typeof replaceMegaAccountSession;
  markConnected: typeof markAccountConnected;
}

function defaultDeps(): ReconnectDeps {
  return {
    login: loginToMega,
    verify: verifyStoredSession,
    persist: replaceMegaAccountSession,
    markConnected: markAccountConnected,
  };
}

/**
 * Reconnect one MEGA account for one website user.
 *
 * @param accountId MegaAccount.id - must belong to `userId`
 * @param userId    website user id (ownership scope)
 * @param password  MEGA password (used once; never persisted or logged)
 * @param mfaCode   optional 2FA code (used once; never persisted or logged)
 */
export async function reconnectMegaAccount(
  accountId: number,
  userId: string,
  password: string,
  mfaCode: string | undefined,
  deps: ReconnectDeps = defaultDeps(),
): Promise<ReconnectOutcome> {
  try {
    if (!password) {
      return { ok: false, ...pick('missing-password') };
    }

    // Fail before any MEGA contact when the server cannot store sessions.
    if (!hasEnvelopeKey()) {
      return { ok: false, ...pick('not-configured') };
    }

    // Ownership: null when the account does not exist FOR THIS USER. Foreign
    // ids are indistinguishable from missing ones (both -> not-found).
    const account = await getMegaAccountForUser(accountId, userId);
    if (!account) {
      return { ok: false, ...pick('not-found') };
    }

    // Reconnect applies exclusively to accounts whose session is unusable.
    if (account.status !== MEGA_ACCOUNT_STATUSES.REAUTH_REQUIRED) {
      return { ok: false, ...pick('wrong-status') };
    }

    // --- explicit authentication (password used exactly once) --------------
    // The email is NOT taken from user input: it is fixed to the linked one,
    // so reconnect can never swap the MEGA identity under an existing label.
    let material: MegaSessionMaterial;
    try {
      material = await deps.login(account.megaEmail, password, mfaCode);
    } catch (err) {
      // The password dies with this request scope; the account stays
      // REAUTH_REQUIRED and its stored material is untouched.
      if (err instanceof MegaError) {
        if (err.kind === 'mfa') return { ok: false, ...pick('mfa') };
        if (err.kind === 'transient') return { ok: false, ...pick('transient') };
        return { ok: false, ...pick('auth-failed') };
      }
      return { ok: false, ...pick('unexpected') };
    }

    // Sanity: MEGA must confirm the same account identity that was linked.
    if (account.megaUserId && material.user && material.user !== account.megaUserId) {
      return { ok: false, ...pick('identity-mismatch') };
    }

    // --- verify resumability via the password-less path --------------------
    // CONNECTED is only claimed if the material we are about to store loads
    // through the exact code path sync/playback use. Read-only: one a=ug.
    const check: SessionResumeCheck = await deps.verify(material);
    if (!check.ok) {
      return { ok: false, ...pick('session-verify-failed') };
    }

    // --- persist encrypted material, then mark connected -------------------
    // Strict order: encrypt+persist FIRST, status flip SECOND. If persistence
    // fails, CONNECTED is never claimed and the account stays REAUTH_REQUIRED.
    try {
      evictMegaSession(accountId); // drop any stale cached session first
      await deps.persist(accountId, userId, material);
      await deps.markConnected(accountId, userId);
    } catch (err) {
      evictMegaSession(accountId);
      console.warn(
        `[mega-reauth] MegaAccount ${accountId} session persistence failed: ${
          err instanceof MegaConfigError ? 'not-configured' : 'unknown'
        }`,
      );
      return { ok: false, ...pick('persist-failed') };
    } finally {
      // Tear down the verification transport WITHOUT a=sml: the session must
      // keep living on MEGA's side - it is now the stored session.
      closeMegaSession(check.storage);
    }

    // NOTE: no sync is enqueued here. Authentication and synchronization are
    // separate actions (user clicks "Sync Now"; the scheduler only ever uses
    // the stored encrypted session).
    return { ok: true };
  } catch {
    return { ok: false, ...pick('unexpected') };
  }
}

function pick(reason: ReconnectFailureReason): { reason: ReconnectFailureReason; message: string } {
  return { reason, message: RECONNECT_ERROR_RESPONSES[reason].message };
}
