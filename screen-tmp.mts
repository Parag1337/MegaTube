import { chromium } from 'playwright';
const BASE = 'http://localhost:3000';
// argv: token then slug:ownerTag pairs (ownerTag selects cookie jar)
const token = process.argv[2];
const slugs: string[] = process.argv.slice(3);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: 'session_token', value: token, domain: 'localhost', path: '/' }]);
for (const slug of slugs) {
  const page = await ctx.newPage();
  const reqs: string[] = [];
  page.on('response', async (res) => {
    if (res.url().includes('/api/media/')) {
      reqs.push(`${res.status()} ${res.headers()['content-type'] || ''} rng=${res.request().headers()['range'] || '(none)'}`);
    }
  });
  await page.goto(`${BASE}/video/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForSelector('[data-media-player]', { timeout: 30000 }).catch(() => {});
  await page.waitForSelector('[data-media-player] video', { timeout: 30000 }).catch(() => {});
  let final = '';
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(5000);
    const st: any = await page.evaluate(`(function () {
      var v = document.querySelector('[data-media-player] video');
      if (!v) return { noVideo: true };
      return { rs: v.readyState, t: +v.currentTime.toFixed(1), d: v.duration, err: v.error ? v.error.code : null };
    })()`).catch(() => ({ evalFail: true }));
    final = JSON.stringify(st);
    if ((st as any).rs >= 3) break;
  }
  console.log(`${slug} :: ${final}`);
  console.log(`   net: ${reqs.slice(0, 6).join(' | ')}`);
  await page.close().catch(() => {});
}
await browser.close();
process.exit(0);
