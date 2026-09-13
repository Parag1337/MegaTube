import { chromium } from 'playwright';
const BASE = 'http://localhost:3000';
const [token, slug] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: 'session_token', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
const seen: string[] = [];
page.on('response', (res) => {
  if (res.url().includes('/api/media/')) {
    const h = res.headers();
    seen.push(`${res.status()} ct=${h['content-type']} xpath=${h['x-media-path'] || '-'}`);
  }
});
await page.goto(`http://localhost:3000/video/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('[data-media-player] video', { timeout: 30000 }).catch(() => console.log('NO VIDEO EL'));
const t0 = Date.now();
// instrument early for events
await page.evaluate(`(function () {
  window.__evts = [];
  var v = document.querySelector('[data-media-player] video');
  window.__v = v;
  if (!v) return;
  ['loadedmetadata','canplay','playing','waiting','stalled','suspend','abort','error','emptied'].forEach(function (e) {
    v.addEventListener(e, function () { window.__evts.push(e); });
  });
})()`).catch(() => {});
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(10000);
  const st: any = await page.evaluate(`(function () {
    var v = window.__v || document.querySelector('[data-media-player] video');
    if (!v) return { noVideo: true };
    var buf = []; for (var j = 0; j < v.buffered.length; j++) buf.push(v.buffered.start(j).toFixed(0) + '-' + v.buffered.end(j).toFixed(0));
    return { rs: v.readyState, ns: v.networkState, t: +v.currentTime.toFixed(1), d: v.duration, err: v.error ? v.error.code : null, buf: buf, evts: (window.__evts || []).join(',') };
  })()`).catch((e) => ({ evalErr: String(e).slice(0, 60) }));
  console.log(`t=${((Date.now() - t0) / 1000) | 0}s`, JSON.stringify(st));
  if ((st as any).rs >= 3) break;
}
console.log('responses:', JSON.stringify(seen));
await browser.close();
process.exit(0);
