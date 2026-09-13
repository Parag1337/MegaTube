import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const slug = process.argv[2] || 'corporal-punishment-pov-strapon-role-play-strap-o-nmommys-perv-manyvids-xxx-porn-video-in-hd-x-x-x-tube';
const WAIT = Number(process.argv[3] || 90) * 1000;

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const net = [];
page.on('request', (r) => {
  if (r.url().includes('/api/media/') && !r.url().includes('thumbs'))
    net.push({ t: Date.now(), ev: 'req', range: r.headers()['range'] || '(open)', url: r.url().slice(-12) });
});
page.on('response', (r) => {
  if (r.url().includes('/api/media/') && !r.url().includes('thumbs'))
    net.push({ t: Date.now(), ev: `res-${r.status()}`, cr: (r.headers()['content-range'] || '').slice(0, 40), url: r.url().slice(-12) });
});
page.on('requestfailed', (r) => {
  if (r.url().includes('/api/media/'))
    net.push({ t: Date.now(), ev: 'FAILED:' + (r.failure()?.errorText || '?'), url: r.url().slice(-12) });
});
const events = [];
await page.exposeFunction('__ev', (e) => events.push({ t: Date.now(), e }));

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input#email', 'temp@gmail.com');
await page.fill('input#password', 'validation123');
await page.click('button[type="submit"]');
await page.waitForURL(`${BASE}/account`, { timeout: 30000 });
await page.goto(`${BASE}/video/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate(() => {
  const v = document.querySelector('video');
  if (!v) return 'no-video';
  for (const e of ['loadstart','loadedmetadata','loadeddata','canplay','canplaythrough','playing','waiting','stalled','suspend','abort','error','emptied','seeking','seeked','progress']) {
    v.addEventListener(e, () => window.__ev(e + ` rs=${v.readyState} t=${Math.round(v.currentTime*10)/10}`));
  }
  return 'hooked';
}).then((r) => console.log('hook:', r));
await page.waitForTimeout(4000);
// intentional navigation = user wants playback: click center (gesture toggles play)
await page.locator('[data-media-player]').first().click({ timeout: 15000, position: { x: 400, y: 200 } }).catch(() => console.log('click failed'));
const t0 = Date.now();
let last = null;
while (Date.now() - t0 < WAIT) {
  await page.waitForTimeout(5000);
  last = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { paused: v.paused, t: Math.round(v.currentTime * 10) / 10, rs: v.readyState, ns: v.networkState, buf: v.buffered.length ? Math.round(v.buffered.end(v.buffered.length - 1)) : 0, err: v.error ? v.error.code : null } : null;
  });
  if (last && !last.paused && last.t > 2) break;
}
console.log('FINAL:', JSON.stringify(last));
const start = net.length ? net[0].t : Date.now();
for (const n of net) console.log(`+${((n.t - start) / 1000).toFixed(1)}s`, n.ev, n.range || n.cr || n.url || '');
console.log('EVENTS:');
const e0 = events.length ? net[0].t : Date.now();
for (const e of events) console.log(`+${((e.t - start) / 1000).toFixed(1)}s`, e.e);
await browser.close();
