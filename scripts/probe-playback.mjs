import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

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
    return v
      ? {
          readyState: v.readyState,
          paused: v.paused,
          muted: v.muted,
          currentTime: v.currentTime,
          duration: v.duration,
          width: v.videoWidth,
          height: v.videoHeight,
          networkState: v.networkState,
        }
      : null;
  });

const samples = [];
for (let i = 0; i < 10; i++) {
  const s = await read().catch(() => null);
  if (s) samples.push(s);
  await page.waitForTimeout(2000);
}

console.log('playback samples (2s apart):');
for (const s of samples) {
  console.log(
    `  t=${s.currentTime.toFixed(2)}s dur=${Number.isFinite(s.duration) ? s.duration.toFixed(1) : '?'} readyState=${s.readyState} paused=${s.paused} muted=${s.muted} ${s.width}x${s.height}`,
  );
}

const first = samples[0];
const last = samples[samples.length - 1];
const advancing = last && first && last.currentTime > first.currentTime + 1;
console.log('\nRESULT:', advancing ? 'PLAYBACK CONFIRMED - currentTime advances' : 'no advance detected');
console.log(
  `first: t=${first?.currentTime?.toFixed(2)} readyState=${first?.readyState}`,
  `| last: t=${last?.currentTime?.toFixed(2)} readyState=${last?.readyState} dims=${last?.width}x${last?.height}`,
);
await page.screenshot({ path: '/tmp/probe-playback.png' });
await browser.close();
process.exit(advancing ? 0 : 1);