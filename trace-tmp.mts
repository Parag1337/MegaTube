import { chromium } from 'playwright';
const BASE = 'http://localhost:3000';
const [token, slug] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: 'session_token', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) console.log(`  [${m.type()}]`, m.text().slice(0, 160));
});
page.on('pageerror', (e) => console.log(`  [pageerror]`, String(e).slice(0, 200)));
page.on('request', (r) => {
  if (r.url().includes('/api/media/')) console.log(`  [req] ${r.method()} ${r.url().split('/').pop()} range=${r.headers()['range'] || '(none)'}`);
});
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/media/')) console.log(`  [reqfail] ${r.method()} ${r.url().split('/').pop()} ${r.failure()?.errorText}`);
});
page.on('requestfinished', async (r) => {
  if (r.url().includes('/api/media/')) {
    const res = await r.response().catch(() => null);
    console.log(`  [reqdone] ${r.method()} ${r.url().split('/').pop()} -> ${res?.status() ?? '?'}`);
  }
});
page.on('response', async (res) => {
  if (res.url().includes('/api/media/')) {
    const h = res.headers();
    console.log(`  [res] ${res.status()} ct=${h['content-type']} len=${h['content-length']} cr=${h['content-range']} xpath=${h['x-media-path']}`);
  }
});
await page.goto(`${BASE}/video/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-media-player] video', { timeout: 30000 }).catch(() => console.log('NO VIDEO EL'));
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(5000);
  const st: any = await page.evaluate(`(function () {
    var v = document.querySelector('[data-media-player] video');
    if (!v) return { noVideo: true };
    var buf = []; for (var j = 0; j < v.buffered.length; j++) buf.push(v.buffered.start(j).toFixed(0) + '-' + v.buffered.end(j).toFixed(0));
    return { rs: v.readyState, ns: v.networkState, t: +v.currentTime.toFixed(1), d: v.duration, err: v.error ? v.error.code : null, buf: buf, paused: v.paused };
  })()`).catch((e) => ({ evalErr: String(e).slice(0, 80) }));
  console.log(`t=${(i + 1) * 5}s`, JSON.stringify(st));
}
await browser.close();
process.exit(0);
