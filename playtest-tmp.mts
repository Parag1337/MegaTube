import { chromium } from 'playwright';
// usage: token slug cookieJar
const [token, slug] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext();
await ctx.addCookies([{ name: 'session_token', value: token, domain: 'localhost', path: '/' }]);
const page = await ctx.newPage();
const t0 = Date.now();

page.on('requestfailed', (r) => {
  if (r.url().includes('/api/media/')) console.log(`  [reqfail t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${r.failure()?.errorText}`);
});
page.on('response', (res) => {
  if (res.url().includes('/api/media/')) console.log(`  [res t+${((Date.now() - t0) / 1000).toFixed(1)}s] ${res.status()} xpath=${res.headers()['x-media-path']}`);
});

await page.goto(`http://localhost:3000/video/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForSelector('[data-media-player] video', { timeout: 30000 }).catch(() => console.log('NO VIDEO'));

// wait for a real video element with metadata
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(3000);
  const st: any = await page.evaluate(`(function () {
    var v = document.querySelector('[data-media-player] video'); if (!v) return null;
    return { rs: v.readyState, d: v.duration };
  })()`).catch(() => null);
  console.log(`  probe t+${((Date.now() - t0) / 1000) | 0}s rs=${st?.rs} d=${st?.d}`);
  if (st && st.rs >= 3) break;
}

const before: any = await page.evaluate(`(function () {
  var v = document.querySelector('[data-media-player] video');
  window.__evts = [];
  ['playing','pause','waiting','error','abort','stalled','suspend'].forEach(function (e) {
    v.addEventListener(e, function () { window.__evts.push(e + '@' + Math.round(v.currentTime || 0)); });
  });
  return { t: v.currentTime, paused: v.paused };
})()`);
console.log(`  BEFORE play(): t=${before.t} paused=${before.paused}`);

// manual play()
const playRes: any = await page.evaluate(`(function () {
  var v = document.querySelector('[data-media-player] video');
  var p = v.play();
  return { resolved: p ? 'promise' : 'none', t: v.currentTime };
})()`);
console.log(`  play() called -> ${JSON.stringify(playRes)}`);

let last = '';
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(5000);
  const st: any = await page.evaluate(`(function () {
    var v = document.querySelector('[data-media-player] video');
    return { t: +v.currentTime.toFixed(1), d: v.duration, rs: v.readyState, paused: v.paused, err: v.error ? v.error.code : null, evts: (window.__evts || []).join(',') };
  })()`).catch(() => ({}));
  last = JSON.stringify(st);
  console.log(`  t+${((Date.now() - t0) / 1000) | 0}s ${last}`);
  if ((st as any).t > 10) break;
}
console.log('=== done ===', last);
await browser.close();
process.exit(0);