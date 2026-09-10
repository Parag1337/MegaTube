/**
 * Regression tests for the MAIN WEBSITE authentication navigation and
 * error handling (NOT MEGA account auth):
 *
 *   - /login shows a "Sign up" link that navigates to /register
 *   - /register shows a "Log in" link that navigates to /login
 *   - the links work with a real touch tap on an emulated Android Chrome
 *     device (regression for the LAN/Tailscale phone-testing scenario)
 *   - invalid login credentials produce a clean error (no session)
 *   - nonexistent account produces a clean error (no session)
 *   - the header Logout (HTML form action) redirects to /login (the public
 *     landing page) instead of landing on a raw JSON endpoint
 *
 * The registration/login/logout/session mechanics themselves are covered by
 * tests/e2e/auth.spec.mjs; this file guards the navigation + error UX.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

function randomEmail() {
  return `nav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

test.describe('auth navigation links', () => {
  test('/login has a working "Sign up" link to /register', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.waitForLoadState('networkidle');

    const signup = page.locator('a[href="/register"]').last();
    await expect(signup).toBeVisible();
    await expect(signup).toHaveAttribute('href', '/register');

    await signup.click();
    await page.waitForURL('**/register');
    await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
  });

  test('/register has a working "Log in" link to /login', async ({ page }) => {
    await page.goto(`${BASE}/register`);
    await page.waitForLoadState('networkidle');

    const login = page.locator('a[href="/login"]').last();
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute('href', '/login');

    await login.click();
    await page.waitForURL('**/login');
    await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible();
  });

  // The original bug report came from Android Chrome over the LAN/Tailscale
  // URL. A native <a> tap cannot be broken by JS, but this guards against a
  // future regression (e.g. someone converting the link to an onClick
  // handler) on exactly the device class that reported it.
  test('signup link works via touch tap on emulated Android Chrome', async ({ browser }) => {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/login`);
      await page.waitForLoadState('networkidle');

      await page.locator('a[href="/register"]').last().tap();
      await page.waitForURL('**/register');
      await expect(page.getByRole('heading', { name: 'Create an account' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});

test.describe('login error handling', () => {
  test('invalid password shows a clean error and does not log in', async ({ page }) => {
    const email = randomEmail();
    // Register a real account first so the email exists.
    await page.goto(`${BASE}/register`);
    await page.fill('input#email', email);
    await page.fill('input#password', 'password1234');
    await page.fill('input#confirm', 'password1234');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/account');

    // Log out, then try a wrong password.
    await page.click('button:has-text("Logout")');
    await page.goto(`${BASE}/login`);
    await page.fill('input#email', email);
    await page.fill('input#password', 'definitely-wrong-password');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Invalid email or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // No session may have been established.
    await page.goto(`${BASE}/account`);
    await page.waitForURL('**/login');
  });

  test('nonexistent account shows a clean error', async ({ page }) => {
    await page.goto(`${BASE}/login`);
    await page.fill('input#email', 'does-not-exist-9x7@example.com');
    await page.fill('input#password', 'password1234');
    await page.click('button[type="submit"]');

    await expect(page.locator('text=Invalid email or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('logout as HTML form action', () => {
  test('header logout redirects home and clears the session', async ({ page }) => {
    const email = randomEmail();
    await page.goto(`${BASE}/register`);
    await page.fill('input#email', email);
    await page.fill('input#password', 'password1234');
    await page.fill('input#confirm', 'password1234');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/account');

    // The header Logout is a native form POST to /api/auth/logout. It must
    // land the user on a real page (not a JSON document at the API path).
    // /login is the correct landing: the home page requires authentication.
    await page.click('header form[action="/api/auth/logout"] button[type="submit"]');
    await page.waitForURL('**/login');
    await expect(page).toHaveURL(/\/login$/);

    // Session is really gone: protected route bounces to /login.
    await page.goto(`${BASE}/account`);
    await page.waitForURL('**/login');
  });
});
