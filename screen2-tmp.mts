import { chromium } from 'playwright';
const BASE = 'http://localhost:3000';
const TOKENS: Record<string, string> = {
  '1': process.argv[2],
  '15': process.argv[3],
  '2': process.argv[3],
};
const specs: string[] = process.argv.slice(4); // slug:acct
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
for (const spec of specs) {
  const [slug, acct] = spec.split(':');
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'session_token', value: TOKENS[acct], domain: 'localhost', path: '/' }]);
  const page = await ctx.newPage();
  let reqs = 0;
  let lastStatus = '';
  page.on('request', (r) => { if (r.url().includes('/api/media/')) reqs++; });
  page.on('response', (res) => { if (res.url().includes('/api/media/')) lastStatus = `${res.status()}`; });
  page.on('requestfailed', (r) => { if (r.url().includes('/api/media/')) lastStatus += '/ABORT'; });
  await page.goto(`${BASE}/video/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForSelector('[data-media-player] video', { timeout: 30000 }).catch(() => {});
  let final = '';
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(5000);
    const st: any = await page.evaluate(`(function () {
      var v = document.querySelector('[data-media-player] video');
      if (!v) return { noVideo: true };
      return { rs: v.readyState, d: v.duration, err: v.error ? v.error.code : null };
    })()`).catch(() => ({ evalFail: true }));
    final = JSON.stringify(st);
    if ((st as any).rs >= 3) break;
  }
  console.log(`${slug} :: ${final} reqs=${reqs} last=${lastStatus}`);
  await ctx.close().catch(() => {});
}
await browser.close();
process.exit(0);
