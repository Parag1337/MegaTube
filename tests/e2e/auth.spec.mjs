import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

async function register(page, email, password) {
  await page.goto(`${BASE}/register`);
  await page.waitForLoadState('networkidle');
  await page.fill('input#email', email);
  await page.fill('input#password', password);
  await page.fill('input#confirm', password);
  await page.click('button[type="submit"]');
}

async function login(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.waitForLoadState('networkidle');
  await page.fill('input#email', email);
  await page.fill('input#password', password);
  await page.click('button[type="submit"]');
}

test.describe('registration', () => {
  test('register with valid data succeeds', async ({ page }) => {
    const email = `register-${Date.now()}@example.com`;
    const password = 'password1234';
    await register(page, email, password);
    await page.waitForURL(`${BASE}/account`);
    expect(page.url()).toContain('/account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  });

  test('rejects duplicate email via API', async ({ request }) => {
    const email = `dupapi-${Date.now()}@example.com`;
    const res = await request.post(`${BASE}/api/auth/register`, {
      data: { email, password: 'password1234', confirmPassword: 'password1234' },
    });
    expect(res.status()).toBe(201);
    const second = await request.post(`${BASE}/api/auth/register`, {
      data: { email, password: 'password1234', confirmPassword: 'password1234' },
    });
    expect(second.status()).toBe(400);
    const body = await second.json();
    expect(body.error).toBe('Invalid email or password.');
  });

  test('rejects invalid email via API', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/register`, {
      data: { email: 'not-an-email', password: 'password1234', confirmPassword: 'password1234' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid email address.');
  });

  test('rejects short password via API', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/register`, {
      data: { email: `short-${Date.now()}@example.com`, password: 'short', confirmPassword: 'short' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Password must be at least 8 characters.');
  });

  test('rejects mismatched password confirmation via API', async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/register`, {
      data: { email: `mismatch-${Date.now()}@example.com`, password: 'password1234', confirmPassword: 'different' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Passwords do not match.');
  });
});

test.describe('login and session', () => {
  let testEmail;
  let testPassword;

  test.beforeEach(async ({ page }) => {
    testEmail = `session-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    testPassword = 'password1234';
    await register(page, testEmail, testPassword);
    await page.waitForURL(`${BASE}/account`);
  });

  test('account page shows the logged-in email', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.locator(`text=${testEmail}`)).toBeVisible();
  });

  test('persists across page refresh', async ({ page }) => {
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
    await expect(page.locator(`text=${testEmail}`)).toBeVisible();
  });

  test('sidebar shows Account link and account menu offers Sign out', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('link', { name: 'Account', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  });

  test('logout clears session and redirects to home', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    // The server-side logout redirects to /login, the public landing page
    // (the home page itself requires authentication and would bounce there).
    await page.waitForURL('**/login');
    expect(page.url()).toContain('/login');
  });

  test('protected route redirects to login when logged out', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.goto(`${BASE}/account`);
    await page.waitForURL(`${BASE}/login`);
    expect(page.url()).toContain('/login');
  });

  test('login restores session', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, testEmail, testPassword);
    await page.waitForURL(`${BASE}/account`);
    expect(page.url()).toContain('/account');
    await expect(page.getByRole('heading', { name: 'Account', exact: true })).toBeVisible();
  });

  test('settings page is accessible when authenticated', async ({ page }) => {
    await page.goto(`${BASE}/account/settings`);
    await page.waitForURL(`${BASE}/account/settings`);
    expect(page.url()).toContain('/account/settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  });
});
