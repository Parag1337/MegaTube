import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text().slice(0, 200)}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message.slice(0, 200)}`));

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(1000);

let megaFrame = null;
for (let i = 0; i < 40 && !megaFrame; i++) {
  megaFrame = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!megaFrame) await page.waitForTimeout(500);
}
console.log('frame:', megaFrame?.url()?.slice(0, 90));

if (megaFrame) {
  megaFrame.on('console', (m) => console.log(`[mega:${m.type()}] ${m.text().slice(0, 220)}`));
  megaFrame.on('pageerror', (e) => console.log(`[mega:pageerror] ${e.message.slice(0, 220)}`));
  await page.waitForTimeout(8000);

  const state = await megaFrame.evaluate(() => {
    const v = document.querySelector('video');
    const vw = document.querySelector('.video-wrapper');
    return {
      hasVideo: !!v,
      hasVideoWrapper: !!vw,
      video: v
        ? { readyState: v.readyState, paused: v.paused, muted: v.muted, t: v.currentTime, w: v.videoWidth, h: v.videoHeight }
        : null,
      wrapperHTML: vw ? vw.innerHTML.slice(0, 400) : null,
      bodyKids: [...document.body.children].map((c) => c.tagName + '#' + (c.id || '')).slice(0, 14),
    };
  });
  console.log('player state:', JSON.stringify(state, null, 1).slice(0, 1500));
}
await page.screenshot({ path: '/tmp/probe-autoplay.png' });
await browser.close();