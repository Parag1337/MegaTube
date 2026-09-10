import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const videoRequests = [];
page.on('request', (r) => {
  if (r.url().includes('userstorage.mega.co.nz')) videoRequests.push(r.url());
});

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(1000);

let megaFrame = null;
for (let i = 0; i < 40 && !megaFrame; i++) {
  megaFrame = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!megaFrame) await page.waitForTimeout(500);
}

const read = async () =>
  megaFrame.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    let buffered = 0;
    try {
      for (let i = 0; i < v.buffered.length; i++) buffered = Math.max(buffered, v.buffered.end(i));
    } catch {}
    return {
      t: v.currentTime,
      dur: v.duration,
      rs: v.readyState,
      ns: v.networkState,
      paused: v.paused,
      buffered,
      src: (v.currentSrc || '').slice(0, 60),
      error: v.error ? `${v.error.code}` : null,
    };
  });

let lastT = -1;
let advanced = false;
for (let i = 0; i < 20; i++) {
  const s = await read().catch(() => null);
  if (s) {
    console.log(
      `[${String(i * 3).padStart(2)}s] t=${s.t.toFixed(2)} dur=${Number.isFinite(s.dur) ? s.dur.toFixed(1) : '?'} rs=${s.rs} ns=${s.ns} paused=${s.paused} buffered=${s.buffered.toFixed(1)} ${s.src ? 'src' : ''}${s.error ? ' ERR:' + s.error : ''}`,
    );
    if (s.t > lastT + 0.05) advanced = true;
    lastT = s.t;
  }
  await page.waitForTimeout(3000);
}

console.log('\ntotal video chunk requests:', videoRequests.length);
console.log('RESULT:', advanced ? 'PLAYBACK CONFIRMED - currentTime advanced' : 'currentTime never advanced');
await page.screenshot({ path: '/tmp/probe-playback2.png' });
await browser.close();
process.exit(advanced ? 0 : 1);