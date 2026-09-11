/**
 * MEGA account authentication and session management.
 *
 * Mechanism (identical to the official MEGA SDK / clients):
 *
 *   LOGIN (a=us)
 *     The client proves knowledge of the password (v1: legacy AES stringhash;
 *     v2: PBKDF2-SHA512/100k with the account salt obtained via a=us0). The
 *     API responds with:
 *       k     - 16-byte master key, AES-128-ECB encrypted (pw-derived key)
 *       privk - the account's RSA private key, ECB encrypted
 *       csid  - a 43-byte session id, RSA-encrypted
 *     The client derives:  masterKey = ECB_dec(k)
 *                         rsaPriv   = ECB_dec(privk)
 *                         sid       = RSA_dec(csid)[0:43]
 *
 *   AUTHENTICATED REQUESTS
 *     Every API request carries the stored session id as a query parameter
 *     (sid=...). No password or other credential is ever sent again.
 *
 *   SESSION RESUME
 *     A stored (sid, masterKey, rsaPriv) triple is a complete, reusable
 *     session: building a new API client with the stored sid and issuing any
 *     authenticated call (we use a=ug, "get user info") resumes the session
 *     with no password. If MEGA has expired or the user revoked the session
 *     (mega.nz -> Sessions), the API answers -15 (ESID) and the account must
 *     be re-authenticated with the password.
 *
 *   LOGOUT / REVOCATION
 *     a=sml kills the session server-side. We call it best-effort when the
 *     user disconnects a MEGA account; if the session is already dead the
 *     call simply fails and we discard local material either way.
 *
 * The MEGA password is used exactly once (login), discarded immediately
 * (megajs removes it from its options object after the request is built),
 * and is never stored, logged, or returned to the browser.
 *
 * What IS persisted (encrypted at rest, see lib/mega/envelope.ts):
 *   sid + masterKey + RSA private key + MEGA user id + name + email.
 */

import { Storage } from 'megajs';
import type { Storage as StorageType } from 'megajs';
import { b64UrlToBuffer, bufferToB64Url } from './util';
import { decodeFileNodes } from './nodes';
import type { DecodedFileNode, RawFetchResponse } from './nodes';

export interface MegaSessionMaterial {
  v: 1;
  /** 43-byte session id, base64url. */
  sid: string;
  /** 16-byte master key, base64url. */
  masterKey: string;
  /** Account RSA private key components (p, q, d, u) as 28-bit limb arrays, or null. */
  rsa: number[][] | null;
  /** MEGA user id (e.g. "Uxxxxxxxxx"). */
  user: string;
  /** Display name from the account. */
  name: string;
  /** Lowercased account email. */
  email: string;
}

export type MegaErrorKind =
  | 'transient' // retryable (congestion, rate limit, network)
  | 'auth' // invalid credentials / account problem (do not auto-retry)
  | 'mfa' // 2FA code required
  | 'session-expired' // stored sid rejected by MEGA (-15)
  | 'unknown'; // not classified; treat as non-retryable for safety

const RE_SESSION = /(-15)/;
const RE_MFA = /(-26)/;
const RE_AUTH_LOGIN = /(-9)|(-16)|invalid credentials/i;
const RE_TRANSIENT =
  /(-3)|(-4)|(-18)|(-19)|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|temporarily unavailable|aborted|timeout|server returned error|too busy/i;

export class MegaError extends Error {
  kind: MegaErrorKind;
  /** MEGA API error code (e.g. 9 = ENOENT, 15 = ESID) when known. */
  apiCode: number | null;
  constructor(kind: MegaErrorKind, message: string, apiCode: number | null = null) {
    super(message);
    this.name = 'MegaError';
    this.kind = kind;
    this.apiCode = apiCode;
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Classify a MEGA/megajs failure.
 *
 * `context` matters: error -9 during login means "wrong password", while
 * during an authenticated session it means the target object is gone.
 */
export function classifyMegaError(err: unknown, context: 'login' | 'session'): MegaErrorKind {
  const text = errText(err);
  if (RE_SESSION.test(text)) return 'session-expired';
  if (RE_MFA.test(text)) return 'mfa';
  if (context === 'login' && RE_AUTH_LOGIN.test(text)) return 'auth';
  if (RE_TRANSIENT.test(text)) return 'transient';
  if (context === 'login') return 'auth'; // an unexpected login failure is treated as permanent
  return 'unknown';
}

/**
 * Human-safe error text for the UI / lastSyncError column.
 * Never echoes raw error text (which could contain ids/URLs).
 */
export function safeMegaErrorMessage(kind: MegaErrorKind): string {
  switch (kind) {
    case 'session-expired':
      return 'MEGA session expired or was revoked. Reconnect required.';
    case 'auth':
      return 'MEGA rejected the credentials for this account.';
    case 'mfa':
      return 'This MEGA account requires a 2FA code. Reconnect and enter it.';
    case 'transient':
      return 'MEGA is temporarily unavailable. Will retry automatically.';
    case 'unknown':
    default:
      return 'MEGA returned an unexpected error. Will retry automatically.';
  }
}

function toMegaError(err: unknown, context: 'login' | 'session'): MegaError {
  const kind = classifyMegaError(err, context);
  const text = errText(err);
  const m = text.match(/\((-\d+)\)/);
  return new MegaError(kind, safeMegaErrorMessage(kind), m ? Number(m[1]) : null);
}

/**
 * megajs's `API.request` is typed against the global JSON utility type and
 * its `sid` field is not in the .d.ts (it is set at runtime). The protocol
 * commands are plain objects; this helper gives us a clean call signature.
 *
 * Bounded: megajs issues API calls with no timeout of its own, so a MEGA
 * socket that accepts but never answers would pend the caller (e.g. a media
 * request) FOREVER behind an innocent spinner. The timeout rejects with
 * transient-classified text (matches RE_TRANSIENT via "temporarily
 * unavailable") so callers retry / surface a real error instead of hanging.
 */
const MEGA_API_TIMEOUT_MS = 30_000;

function apiRequest(storage: Storage, cmd: Record<string, unknown>): Promise<unknown> {
  const request = storage.api.request as unknown as (
    cmd: Record<string, unknown>,
  ) => Promise<unknown>;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('MEGA API request timed out (temporarily unavailable)'));
    }, MEGA_API_TIMEOUT_MS);
    if (typeof timer === 'object' && typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref(): void }).unref();
    }
  });
  const pending = request.call(storage.api, cmd);
  // The race loser keeps running: a late megajs rejection after the timeout
  // won must not surface as an unhandled rejection.
  pending.catch(() => {});
  return Promise.race([pending, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Attach the session id to a storage API transport (runtime field). */
function attachSid(storage: Storage, sid: string): void {
  (storage.api as unknown as { sid?: string }).sid = sid;
  (storage as unknown as { sid?: string }).sid = sid;
}

// ---------------------------------------------------------------------------
// Login (password used once, never stored)
// ---------------------------------------------------------------------------

/**
 * Authenticate against MEGA with email + password (and optional 2FA code).
 *
 * Returns reusable session material. The password is not retained in the
 * returned material and is dropped from megajs' options after the request.
 *
 * @throws {MegaError} kind 'auth' | 'mfa' | 'transient'
 */
export async function loginToMega(
  email: string,
  password: string,
  mfaCode?: string,
): Promise<MegaSessionMaterial> {
  const storage = new Storage({
    email,
    password,
    secondFactorCode: mfaCode ? mfaCode : undefined,
    autoload: false,
    autologin: false,
    keepalive: false,
  });
  try {
    await storage.login();
  } catch (err) {
    storage.api.close();
    throw toMegaError(err, 'login');
  }

  if (!storage.sid || !storage.key) {
    storage.api.close();
    throw new MegaError('auth', 'MEGA login did not return a session');
  }

  const material: MegaSessionMaterial = {
    v: 1,
    sid: storage.sid,
    masterKey: bufferToB64Url(Buffer.from(storage.key)),
    rsa: Array.isArray(storage.RSAPrivateKey) ? (storage.RSAPrivateKey as number[][]) : null,
    user: String(storage.user ?? ''),
    name: String(storage.name ?? ''),
    email: String(storage.email ?? email).toLowerCase(),
  };

  // Close the API transport without sending sml - we WANT the session to
  // stay alive on MEGA's side (that is the whole point of storing it).
  storage.api.close();
  return material;
}

// ---------------------------------------------------------------------------
// Session resume (no password)
// ---------------------------------------------------------------------------

/**
 * Rebuild a live MEGA session from stored material and verify it by issuing
 * one authenticated call (a=ug). This is the "log in without password" path.
 *
 * @throws {MegaError} kind 'session-expired' when MEGA rejects the stored
 *   session (-15), 'transient' for network/congestion errors.
 */
export async function openMegaSession(material: MegaSessionMaterial): Promise<Storage> {
  if (!material || material.v !== 1 || !material.sid || !material.masterKey) {
    throw new MegaError('session-expired', 'Stored MEGA session is malformed');
  }

  const storage = new Storage({
    email: material.email,
    autoload: false,
    autologin: false,
    keepalive: false,
    // password is intentionally absent: session resume never needs it.
    // megajs's StorageOpts marks it required, but with autologin=false the
    // constructor never touches it.
  } as unknown as ConstructorParameters<typeof Storage>[0]);
  storage.key = b64UrlToBuffer(material.masterKey);
  if (material.rsa) storage.RSAPrivateKey = material.rsa;
  attachSid(storage, material.sid);
  storage.name = material.name;
  storage.user = material.user;

  try {
    const res = (await apiRequest(storage, { a: 'ug' })) as { u?: string; name?: string } | null;
    if (res && typeof res.u === 'string' && res.u) {
      storage.user = res.u;
      if (typeof res.name === 'string' && res.name) storage.name = res.name;
    }
  } catch (err) {
    storage.api.close();
    throw toMegaError(err, 'session');
  }
  return storage;
}

/** Tear down a session without killing it server-side (cache eviction). */
export function closeMegaSession(storage: Storage): void {
  try {
    storage.api.close();
  } catch {
    // ignore
  }
}

export type SessionResumeCheck =
  | { ok: true; storage: Storage }
  | { ok: false; kind: MegaErrorKind };

/**
 * Verify that session material can actually be resumed by the password-less
 * session path (openMegaSession -> one authenticated a=ug call).
 *
 * This is the gate used before an account may be marked CONNECTED: the
 * material that is about to be (or was just) persisted must be loadable by
 * the same code path sync/playback use (withMegaSession). It NEVER performs
 * a password login and only issues the single read-only a=ug call.
 *
 * On success the caller receives the live Storage and MUST close it with
 * closeMegaSession() (never logoutMegaSession - the session must survive).
 *
 * @returns {ok: true, storage} when the session resumed, otherwise {ok:
 *   false, kind} with the classified failure (never raw error text).
 */
export async function verifyStoredSession(
  material: MegaSessionMaterial,
): Promise<SessionResumeCheck> {
  try {
    const storage = await openMegaSession(material);
    return { ok: true, storage };
  } catch (err) {
    if (err instanceof MegaError) return { ok: false, kind: err.kind };
    return { ok: false, kind: classifyMegaError(err, 'session') };
  }
}

/**
 * Kill the session on MEGA's side (a=sml). Best-effort: used on disconnect;
 * failures are fine (the session may already be invalid).
 */
export async function logoutMegaSession(storage: Storage): Promise<void> {
  try {
    await apiRequest(storage, { a: 'sml' });
  } catch {
    // session already dead or network error - local material is deleted anyway
  } finally {
    closeMegaSession(storage);
  }
}

// ---------------------------------------------------------------------------
// Account data access (node tree, temporary download URLs)
// ---------------------------------------------------------------------------

/**
 * Fetch the account's node tree and decode all file nodes.
 *
 * Uses the logged-in API client (sid is attached automatically). Only files
 * (t=0) are returned; folders/inbox/trash are filtered out.
 *
 * @param onScanProgress Optional callback invoked with the running count of
 *   raw nodes examined during decoding (real Phase-A "Scanning MEGA" progress).
 *
 * @throws {MegaError}
 */
export async function fetchAccountFileNodes(
  storage: Storage,
  onScanProgress?: (nodesScanned: number) => void,
): Promise<DecodedFileNode[]> {
  const masterKey = storage.key ? Buffer.from(storage.key) : null;
  if (!masterKey || masterKey.length !== 16) {
    throw new MegaError('session-expired', 'MEGA session has no usable master key');
  }
  let raw: RawFetchResponse;
  try {
    raw = (await apiRequest(storage, { a: 'f', c: 1 })) as unknown as RawFetchResponse;
  } catch (err) {
    throw toMegaError(err, 'session');
  }
  // decryptRsaKey exists at runtime on Storage but is missing from the .d.ts.
  const rsaDecrypt = (storage as unknown as {
    decryptRsaKey?: (ciphertext: Buffer) => Buffer;
  }).decryptRsaKey;
  return decodeFileNodes(raw, String(storage.user ?? ''), masterKey, {
    decryptRsaKey: (c: Buffer) => rsaDecrypt?.(c) ?? Buffer.alloc(0),
  }, onScanProgress);
}

export interface TemporaryDownloadUrl {
  /** Short-lived MEGA storage URL (no credentials embedded, ~10 min TTL). */
  url: string;
  /** File size in bytes, if reported. */
  size: number | null;
}

/**
 * Obtain a temporary download URL for a private node (a=g g=1).
 *
 * The URL is an unguessable, short-lived link issued by the API while our
 * authenticated session is valid. It carries no credentials; MEGA's storage
 * servers accept it directly for ~10 minutes. This is the mechanism the
 * official web player uses for private files.
 *
 * @throws {MegaError}
 */
export async function getTemporaryDownloadUrl(
  storage: Storage,
  nodeId: string,
): Promise<TemporaryDownloadUrl> {
  let res: { g?: string; s?: number } | null;
  try {
    res = (await apiRequest(storage, { a: 'g', g: 1, ssl: 2, n: nodeId })) as {
      g?: string;
      s?: number;
    } | null;
  } catch (err) {
    throw toMegaError(err, 'session');
  }
  if (!res || typeof res.g !== 'string' || !/^https?:\/\//.test(res.g)) {
    throw new MegaError('unknown', 'MEGA did not return a download URL for this file');
  }
  return { url: res.g, size: typeof res.s === 'number' ? res.s : null };
}

/** Validate the shape of stored session material (cheap, offline). */
export function validateSessionMaterial(m: unknown): m is MegaSessionMaterial {
  if (!m || typeof m !== 'object') return false;
  const x = m as Record<string, unknown>;
  return (
    x.v === 1 &&
    typeof x.sid === 'string' &&
    x.sid.length >= 50 &&
    typeof x.masterKey === 'string' &&
    b64UrlToBuffer(x.masterKey).length === 16 &&
    (x.rsa === null || (Array.isArray(x.rsa) && x.rsa.length === 4)) &&
    typeof x.user === 'string' &&
    typeof x.email === 'string'
  );
}
