import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(6000);

let megaFrame = null;
for (let i = 0; i < 40 && !megaFrame; i++) {
  megaFrame = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!megaFrame) await page.waitForTimeout(500);
}

if (megaFrame) {
  const html = await megaFrame.evaluate(() => ({
    pageholder: document.getElementById('pageholder')?.innerHTML?.slice(0, 800),
    mainlayout: document.getElementById('mainlayout')?.innerHTML?.slice(0, 800),
    downloadOverlay: document.getElementById('download_overlay')?.innerHTML?.slice(0, 300),
    bodyText: document.body.innerText?.slice(0, 300),
    hasVideoClass: !!document.querySelector('.video-wrapper, .player, .mega-player, video'),
  }));
  console.log(JSON.stringify(html, null, 2).slice(0, 3500));
}
await page.screenshot({ path: '/tmp/probe-html.png' });
await browser.close();