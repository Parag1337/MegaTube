import { chromium } from 'playwright';
const BASE = 'http://localhost:3000';
const [token, slug] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: 'session_token', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
const t0 = Date.now();
const clock = () => `t+${((Date.now() - t0) / 1000).toFixed(1)}s`;

page.on('response', async (res) => {
  if (res.url().includes('/api/media/')) {
    const h = res.headers();
    console.log(`  [res ${clock()}] ${res.status()} ct=${h['content-type']} cl=${h['content-length'] ?? '-'} cr=${h['content-range'] ?? '-'} ar=${h['accept-ranges'] ?? '-'} xpath=${h['x-media-path'] ?? '-'}`);
  }
});
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/media/')) console.log(`  [reqfail ${clock()}] ${r.failure()?.errorText}`);
});

await page.goto(`${BASE}/video/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('  [nav]', String(e).slice(0, 60)));
await page.waitForSelector('[data-media-player] video', { timeout: 30000 }).catch(() => console.log('  NO VIDEO EL'));

// 1) client-side raw fetch probe: does the route stream bytes to a plain HTTP client?
await page.evaluate(`(function () {
  window.__fetchResult = null;
  fetch('/api/media/151', { headers: { Range: 'bytes=0-' } }).then(async (r) => {
    const started = Date.now();
    const firstByteMs = [];
    const reader = r.body.getReader();
    await reader.read();  // init/start of stream
    firstByteMs.push(Date.now() - started);
    window.__fetchResult = { status: r.status, ct: r.headers.get('content-type'), cl: r.headers.get('content-length'), cr: r.headers.get('content-range'), firstByteMs };
  }).catch((e) => { window.__fetchResult = { err: String(e).slice(0, 120) }; });
})()`);

// 2) live media elements: watch the Vidstack one closely
await page.evaluate(`(function () {
  window.__evts = [];
  var v = document.querySelector('[data-media-player] video');
  window.__v = v;
  if (!v) return;
  ['loadedmetadata','loadeddata','canplay','canplaythrough','playing','waiting','stalled','suspend','abort','emptied','error','play','pause'].forEach(function (e) {
    v.addEventListener(e, function () { window.__evts.push(e + '@' + Math.round(v.currentTime || 0)); });
  });
})()`).catch(() => {});

for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(5000);
  const st: any = await page.evaluate(`(function () {
    var fr = window.__fetchResult;
    var v = window.__v;
    if (!v) return { noVideo: true, fr: fr };
    var buf = []; for (var j = 0; j < v.buffered.length; j++) buf.push(v.buffered.start(j).toFixed(0) + '-' + v.buffered.end(j).toFixed(0));
    return { rs: v.readyState, ns: v.networkState, t: +v.currentTime.toFixed(1), d: v.duration, err: v.error ? v.error.code : null, buf: buf, paused: v.paused, evts: (window.__evts || []).slice(-14).join(','), fr: fr };
  })()`).catch((e) => ({ evalErr: String(e).slice(0, 80) }));
  console.log(`  t=${((Date.now() - t0) / 1000) | 0}s ${JSON.stringify(st)}`);
  if ((st as any).rs >= 3 && (st as any).t > 1) break;
}
console.log('=== done ===');
await browser.close();
process.exit(0);