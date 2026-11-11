import { chromium } from 'playwright';
const BASE = 'http://localhost:3101';
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const email = `prod-${Date.now()}@example.com`;
// register
await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
await page.fill('input#email', email);
await page.fill('input#password', 'password1234');
await page.fill('input#confirm', 'password1234');
await page.click('button[type="submit"]');
await page.waitForURL('**/account', { timeout: 120000 });
console.log('registered ok');
// sign out via account menu
await page.getByRole('button', { name: 'Account menu' }).click();
await page.getByRole('menuitem', { name: 'Sign out' }).click();
await page.waitForURL('**/login', { timeout: 60000 });
console.log('signed out, at:', page.url().slice(BASE.length));
// protected bounces
await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
await page.waitForURL('**/login', { timeout: 60000 });
console.log('protected bounce ok');
// wrong password
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input#email', email);
await page.fill('input#password', 'wrong-pass');
await page.click('button[type="submit"]');
await page.waitForSelector('text=Invalid email or password.', { timeout: 60000 });
console.log('invalid-password error ok');
// still logged out?
await page.goto(`${BASE}/account`, { waitUntil: 'domcontentloaded' });
await page.waitForURL('**/login', { timeout: 60000 });
console.log('still logged out ok');
// login for real (callbackUrl check)
await page.goto(`${BASE}/watchlist`, { waitUntil: 'domcontentloaded' });
await page.waitForURL('**/login**', { timeout: 60000 });
console.log('deep-link login url:', page.url().slice(BASE.length));
await page.fill('input#email', email);
await page.fill('input#password', 'password1234');
await page.click('button[type="submit"]');
await page.waitForURL('**/watchlist', { timeout: 120000 });
console.log('login with callbackUrl lands on watchlist ok');
await browser.close();
