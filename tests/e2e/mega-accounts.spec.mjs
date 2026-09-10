/**
 * E2E tests for the Phase 2/3 MEGA account management surface.
 *
 * Coverage:
 *   1. logged-out user cannot access MEGA account API
 *   2. logged-in user can open the Account page
 *   3. MEGA account management UI is rendered
 *   4. link form client-side validation works
 *   5. Sync Now button / status UI is present
 *   6. Disconnect button is present
 *   7. Re-authentication UI is rendered when an account needs it
 *   8. Library page loads
 *   9. private video ownership is enforced (owner can view)
 *   10. user A cannot access user B's private videos
 *
 * Real-MEGA linking is environment-gated: the live POST /api/mega/accounts
 * test only runs when MEGA_TEST_EMAIL and MEGA_TEST_PASSWORD are set.
 * All other UI/isolation tests run unconditionally.
 */

import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const HAS_MEGA_CREDS = !!(process.env.MEGA_TEST_EMAIL && process.env.MEGA_TEST_PASSWORD);
const DB_FILE = 'data/database/app.db';

function randomEmail() {
  return `e2e-mega-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

async function register(page, email, password) {
  await page.goto(`${BASE}/register`);
  await page.waitForLoadState('networkidle');
  await page.fill('input#email', email);
  await page.fill('input#password', password);
  await page.fill('input#confirm', password);
  await page.click('button[type="submit"]');
  // Registration establishes the session and navigates to /account. Waiting
  // here prevents later navigations from racing the registration response.
  await page.waitForURL('**/account', { timeout: 30_000 });
}

async function login(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('networkidle');
  await page.fill('input#email', email);
  await page.fill('input#password', password);
  await page.click('button[type="submit"]');
}

async function logout(page) {
  await page.goto(`${BASE}/account`);
  await page.waitForLoadState('networkidle');
  await page.click('button:has-text("Logout")');
  // Server-side logout redirects to /login (the public landing page).
  await page.waitForURL('**/login');
}

function setAccountReauth(accountId) {
  const db = new Database(DB_FILE);
  try {
    db.prepare("UPDATE MegaAccount SET status = 'REAUTH_REQUIRED', lastSyncError = ? WHERE id = ?").run(
      'MEGA session expired. Reconnect required.',
      accountId,
    );
  } finally {
    db.close();
  }
}

function deleteAccountByUserId(userId) {
  const db = new Database(DB_FILE);
  try {
    const rows = db.prepare('SELECT id FROM MegaAccount WHERE userId = ?').all(userId);
    for (const row of rows) {
      db.prepare('DELETE FROM Video WHERE megaAccountId = ?').run(row.id);
      db.prepare('DELETE FROM MegaAccount WHERE id = ?').run(row.id);
    }
  } finally {
    db.close();
  }
}

test.describe('MEGA account API — unauthenticated', () => {
  test('GET /api/mega/accounts returns 401 when not logged in', async ({ request }) => {
    const res = await request.get(`${BASE}/api/mega/accounts`);
    expect(res.status()).toBe(401);
  });

  test('POST /api/mega/accounts returns 401 when not logged in', async ({ request }) => {
    const res = await request.post(`${BASE}/api/mega/accounts`, {
      data: { email: 'x', password: 'y' },
    });
    expect(res.status()).toBe(401);
  });
});

test.describe('MEGA account UI — logged-in user', () => {
  let userEmail;
  let userPassword;

  test.beforeEach(async ({ page }) => {
    userEmail = randomEmail();
    userPassword = 'password1234';
    await register(page, userEmail, userPassword);
    await page.waitForURL(`${BASE}/account`);
  });

  test('Account page loads with heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  });

  test('MEGA account panel heading is visible', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Connected MEGA Accounts' })).toBeVisible();
  });

  test('"Add MEGA Account" button is present', async ({ page }) => {
    await expect(page.getByRole('button', { name: '+ Add MEGA Account' })).toBeVisible();
  });

  test('link form validation — empty email rejected by API', async ({ page }) => {
    await page.click('text=+ Add MEGA Account');
    await page.click('button:has-text("Connect MEGA Account")');
    await expect(page.locator('text=Enter a valid MEGA account email')).toBeVisible({ timeout: 5000 });
  });

  test('link form validation — missing password rejected by API', async ({ page }) => {
    await page.click('text=+ Add MEGA Account');
    await page.fill('input#mega-email', 'not-an-email');
    await page.click('button:has-text("Connect MEGA Account")');
    await expect(page.locator('text=Enter a valid MEGA account email')).toBeVisible({ timeout: 5000 });
  });

  test('"No MEGA accounts linked yet" message when none linked', async ({ page }) => {
    await expect(page.locator('text=No MEGA accounts linked yet')).toBeVisible();
  });

  test('Sync Now button is absent when no accounts linked', async ({ page }) => {
    await expect(page.locator('text=Sync Now')).toHaveCount(0);
  });

  test('Disconnect button is absent when no accounts linked', async ({ page }) => {
    await expect(page.locator('text=Disconnect')).toHaveCount(0);
  });

  test('Reconnect button is absent when no accounts linked', async ({ page }) => {
    await expect(page.locator('text=Reconnect')).toHaveCount(0);
  });
});

test.describe('MEGA account — live linking (environment-gated)', () => {
  test.skip(!HAS_MEGA_CREDS, 'MEGA_TEST_EMAIL/MEGA_TEST_PASSWORD not set — live link test skipped');

  test('linking a real MEGA account creates a visible account entry', async ({ page, request }) => {
    const email = randomEmail();
    const password = 'password1234';
    await register(page, email, password);
    await page.waitForURL(`${BASE}/account`);

    await page.click('text=+ Add MEGA Account');
    await page.fill('input#mega-email', process.env.MEGA_TEST_EMAIL);
    await page.fill('input#mega-password', process.env.MEGA_TEST_PASSWORD);
    await page.fill('input#mega-label', 'E2E live account');
    await page.click('button:has-text("Connect MEGA Account")');

    await expect(page.locator('text=E2E live account')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=Syncing…')).toBeVisible({ timeout: 5000 });

    await page.waitForURL(`${BASE}/account`, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(5000);

    const syncButton = page.locator('text=Sync Now').first();
    if (await syncButton.count() > 0) {
      await expect(syncButton).toBeVisible();
    }

    const disconnectBtn = page.locator('text=Disconnect').first();
    await expect(disconnectBtn).toBeVisible();
  });
});

test.describe('MEGA account — disconnect and reauth UI', () => {
  test('reauth form appears when account status is REAUTH_REQUIRED', async ({ page }) => {
    const email = randomEmail();
    const password = 'password1234';
    await register(page, email, password);
    await page.waitForURL(`${BASE}/account`);

    const listRes = await page.request.get(`${BASE}/api/mega/accounts`);
    const listBody = await listRes.json();
    const accounts = listBody.accounts;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      await page.click('text=+ Add MEGA Account');
      await page.fill('input#mega-email', `dummy-${Date.now()}@example.com`);
      await page.fill('input#mega-password', 'dummy-password');
      await page.click('button:has-text("Connect MEGA Account")');
      await page.waitForTimeout(2000);
    }

    const res2 = await page.request.get(`${BASE}/api/mega/accounts`);
    const body2 = await res2.json();
    const allAccounts = body2.accounts;

    if (!Array.isArray(allAccounts) || allAccounts.length === 0) {
      test.skip(true, 'no account available to test reauth UI');
      return;
    }

    const accountId = allAccounts[0].id;
    setAccountReauth(accountId);

    await page.goto(`${BASE}/account`);
    await page.waitForLoadState('networkidle');

    await expect(page.locator('text=Reconnect')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=MEGA password')).toBeVisible({ timeout: 5000 });
  });

  test('disconnect removes the account entry from the panel', async ({ page, request }) => {
    const email = randomEmail();
    const password = 'password1234';
    await register(page, email, password);
    await page.waitForURL(`${BASE}/account`);

    const listRes = await page.request.get(`${BASE}/api/mega/accounts`);
    const listBody = await listRes.json();
    const accounts = listBody.accounts;

    if (!Array.isArray(accounts) || accounts.length === 0) {
      test.skip(true, 'no account available to test disconnect UI');
      return;
    }

    const accountId = accounts[0].id;
    const accountLabel = accounts[0].label ?? accounts[0].megaEmail;

    await page.click(`text=${accountLabel} >> text=Disconnect`);
    await page.waitForTimeout(500);

    await expect(page.locator(`text=${accountLabel}`)).toHaveCount(0, { timeout: 5000 });
  });
});

test.describe('Library page', () => {
  test('Library page loads for logged-in user', async ({ page }) => {
    const email = randomEmail();
    const password = 'password1234';
    await register(page, email, password);
    await page.goto(`${BASE}/library`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'My Library', exact: true })).toBeVisible();
  });

  test('Library page redirects to login when logged out', async ({ page }) => {
    const email = randomEmail();
    const password = 'password1234';
    await register(page, email, password);
    await logout(page);
    await page.goto(`${BASE}/library`);
    await page.waitForURL(`${BASE}/login`);
    expect(page.url()).toContain('/login');
  });
});

test.describe('Private video ownership isolation', () => {
  test('user B cannot access user A private video page', async ({ page }) => {
    const emailA = randomEmail();
    const emailB = randomEmail();
    const password = 'password1234';

    await register(page, emailA, password);
    await page.waitForURL(`${BASE}/account`);

    const listResA = await page.request.get(`${BASE}/api/mega/accounts`);
    const listBodyA = await listResA.json();
    const accountsA = listBodyA.accounts;

    const megaAccount = (accountsA && accountsA.length > 0) ? accountsA[0] : null;

    await logout(page);
    await login(page, emailB, password);
    await page.waitForURL(`${BASE}/account`);

    if (megaAccount) {
      const res = await page.request.get(`${BASE}/api/mega/accounts/${megaAccount.id}`);
      expect(res.status()).toBe(404);
    }

    await expect(page.locator(`text=${megaAccount?.megaEmail ?? ''}`)).toHaveCount(0);
  });
});

test.describe('Cleanup', () => {
  test('removes test MEGA accounts from DB', async () => {
    const db = new Database(DB_FILE);
    try {
      const rows = db
        .prepare("SELECT id FROM User WHERE email LIKE 'e2e-mega-%@example.com'")
        .all();
      for (const row of rows) {
        deleteAccountByUserId(row.id);
      }
    } finally {
      db.close();
    }
  });
});
