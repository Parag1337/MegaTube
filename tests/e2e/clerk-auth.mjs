/**
 * Clerk test authentication.
 *
 * The app no longer has a local email/password form: /login and /register
 * redirect to Clerk's /sign-in and /sign-up. Authenticated E2E therefore
 * needs a real Clerk session. `@clerk/testing` is not installed, so this
 * helper uses the already-present @clerk/backend package to mint a
 * short-lived sign-in ticket and exchanges it on the app's own origin
 * (which sets the localhost Clerk cookies the middleware expects).
 *
 * Required for authenticated tests:
 *   CLERK_SECRET_KEY       development-instance secret key
 *   E2E_CLERK_USER_ID      Clerk user id for the fixture account
 *
 * The helper never logs the ticket or the secret. When local env files are
 * present it loads .env itself, matching `next dev`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createClerkClient } from '@clerk/backend';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

let envLoaded = false;

function loadLocalEnv() {
  if (envLoaded) return;
  envLoaded = true;
  if (process.env.CLERK_SECRET_KEY) return;
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Leave the environment as-is; canSignIn() will report the skip.
    }
  }
}

export function clerkTestConfig() {
  loadLocalEnv();
  return {
    secretKey: process.env.CLERK_SECRET_KEY ?? '',
    userId: process.env.E2E_CLERK_USER_ID ?? '',
    email: process.env.E2E_CLERK_EMAIL ?? '',
  };
}

export function canSignInWithClerk() {
  const { secretKey, userId } = clerkTestConfig();
  return Boolean(secretKey && userId);
}

/**
 * Sign the Playwright page into the app using a one-use Clerk ticket.
 * Throws (rather than silently skipping) when credentials are absent, so a
 * caller that forgot to gate on canSignInWithClerk() fails visibly.
 */
/**
 * Create a disposable Clerk user for a test that needs a pristine account
 * (no linked MEGA accounts). The caller owns cleanup via deleteClerkUser.
 * Users are created in the development instance only.
 */
export async function createClerkTestUser({ email, password }) {
  const { secretKey } = clerkTestConfig();
  if (!secretKey) throw new Error('Clerk E2E requires CLERK_SECRET_KEY');
  const client = createClerkClient({ secretKey });
  const user = await client.users.createUser({
    emailAddress: [email],
    password,
    firstName: 'E2E',
    lastName: 'Mega',
  });
  return user.id;
}

export async function deleteClerkTestUser(userId) {
  const { secretKey } = clerkTestConfig();
  if (!secretKey || !userId) return;
  const client = createClerkClient({ secretKey });
  await client.users.deleteUser(userId).catch(() => {});
}

export async function signInWithClerk(page, { timeoutMs = 45_000, userId } = {}) {
  const config = clerkTestConfig();
  const secretKey = config.secretKey;
  const signInUserId = userId ?? config.userId;
  if (!secretKey || !signInUserId) {
    throw new Error('Clerk E2E requires CLERK_SECRET_KEY and E2E_CLERK_USER_ID');
  }

  const client = createClerkClient({ secretKey });
  const ticket = await client.signInTokens.createSignInToken({
    userId: signInUserId,
    expiresInSeconds: 300,
  });

  try {
    await page.goto(`${BASE}/sign-in?__clerk_ticket=${encodeURIComponent(ticket.token)}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForURL(
      (url) => url.origin === new URL(BASE).origin && !url.pathname.startsWith('/sign-in'),
      { timeout: timeoutMs },
    );
  } finally {
    // The ticket is single-use; revoke it so a failed test cannot leave a
    // usable credential behind. Session revocation is separate and handled
    // by the sign-out tests.
    await client.signInTokens.revokeSignInToken(ticket.id).catch(() => {});
  }
}
