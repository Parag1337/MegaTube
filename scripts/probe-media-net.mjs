/**
 * Phase 0 diagnostic #2: why does the MEGA <video> stay at readyState 0?
 * Tracks video element events + userstorage network traffic in detail.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const mediaReqs = [];
page.on('request', (req) => {
  if (/userstorage|gfs\d+|mega\.nz\/[a-z]+\/(?!embed)/.test(req.url())) {
    mediaReqs.push({ phase: 'req', url: req.url().slice(0, 100), headers: Object.keys(req.headers()).filter((h) => /range|sec|origin/i.test(h)).map((h) => `${h}=${req.headers()[h].slice(0, 40)}`) });
  }
});
page.on('response', (res) => {
  if (/userstorage|gfs\d+/.test(res.url())) {
    mediaReqs.push({ phase: 'res', url: res.url().slice(0, 100), status: res.status(), headers: Object.entries(res.headers()).filter(([h]) => /range|content-/i.test(h)).map(([h, v]) => `${h}=${String(v).slice(0, 60)}`) });
  }
});
page.on('requestfailed', (req) => {
  if (/userstorage|gfs\d+/.test(req.url())) {
    mediaReqs.push({ phase: 'fail', url: req.url().slice(0, 100), err: req.failure()?.errorText });
  }
});

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(600);

let megaFrame = null;
for (let i = 0; i < 30 && !megaFrame; i++) {
  megaFrame = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!megaFrame) await page.waitForTimeout(500);
}
console.log('frame:', megaFrame?.url().slice(0, 80));

// Attach video event listeners inside the frame as soon as it appears.
const attach = async () => {
  try {
    await megaFrame.evaluate(() => {
      const v = document.querySelector('video');
      if (!v || v.__instrumented) return;
      v.__instrumented = true;
      for (const ev of ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'progress', 'stalled', 'suspend', 'waiting', 'error', 'abort', 'emptied']) {
        v.addEventListener(ev, () => {
          window.__vevents = window.__vevents || [];
          window.__vevents.push(`${ev} rs=${v.readyState} t=${v.currentTime.toFixed(2)} paused=${v.paused} net=${v.networkState} err=${v.error?.code ?? '-'}`);
        });
      }
    });
  } catch { /* frame navigated away */ }
};

for (let i = 0; i < 24; i++) {
  await attach();
  await page.waitForTimeout(1000);
}

const finalState = await megaFrame.evaluate(() => {
  const v = document.querySelector('video');
  return {
    hasVideo: !!v,
    state: v ? { readyState: v.readyState, paused: v.paused, muted: v.muted, t: v.currentTime, w: v.videoWidth, h: v.videoHeight, networkState: v.networkState, err: v.error ? { code: v.error.code, msg: v.error.message } : null, src: (v.currentSrc || v.src || '').slice(0, 80), buffered: v.buffered.length ? `${v.buffered.start(0).toFixed(1)}-${v.buffered.end(0).toFixed(1)}` : 'empty' } : null,
    events: window.__vevents ?? [],
  };
}).catch((e) => ({ evalError: e.message }));

console.log('\n=== final video state ===');
console.log(JSON.stringify(finalState, null, 1));

console.log('\n=== media network traffic ===');
for (const r of mediaReqs) console.log(JSON.stringify(r));

await browser.close();
