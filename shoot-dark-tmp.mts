import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:3102';

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('CONSOLE:', String(m.text()).slice(0, 200));
  });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => window.localStorage.setItem('megatube.theme', 'dark'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  console.log('theme attr:', await page.evaluate(() => document.documentElement.dataset.theme));
  const height = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < height; y += 500) {
    await page.evaluate((pos) => window.scrollTo(0, pos), y);
    await page.waitForTimeout(90);
  }
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/tmp/mt-shots/dark-stored.png', fullPage: true });
  console.log('saved dark-stored');
  await ctx.close();
} finally {
  await browser.close();
}
