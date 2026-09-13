import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3102';

const shots = [
  { name: 'landing-desktop', path: '/', width: 1440, height: 900, full: true, dark: false },
  { name: 'landing-desktop-dark', path: '/', width: 1440, height: 900, full: true, dark: true },
  { name: 'landing-mobile', path: '/', width: 390, height: 844, full: true, dark: false },
  { name: 'landing-mobile-dark', path: '/', width: 390, height: 844, full: true, dark: true },
  { name: 'signin-desktop', path: '/sign-in', width: 1440, height: 900, full: false, dark: true },
  { name: 'signin-mobile', path: '/sign-in', width: 390, height: 844, full: false, dark: false },
];

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
try {
  for (const s of shots) {
    const ctx = await browser.newContext({
      viewport: { width: s.width, height: s.height },
      colorScheme: s.dark ? 'dark' : 'light',
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}${s.path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // Scroll through to trigger reveals, then back to top for full page.
    const height = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < height; y += 500) {
      await page.evaluate((pos) => window.scrollTo(0, pos), y);
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(700);
    await page.screenshot({ path: `/tmp/mt-shots/${s.name}.png`, fullPage: s.full });
    console.log(`saved ${s.name}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
