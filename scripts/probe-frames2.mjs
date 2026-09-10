import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(3000);

console.log('all frames:');
for (const f of page.frames()) {
  console.log(' -', f.url().slice(0, 110));
}

// Scan every frame for video elements (incl shadow roots).
for (const f of page.frames()) {
  if (!f.url().startsWith('http')) continue;
  try {
    const info = await f.evaluate(() => {
      const scan = (root, depth, out) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.tagName === 'VIDEO') {
            out.push({ depth, tag: 'VIDEO', cls: String(el.className).slice(0, 40) });
          }
          if (el.shadowRoot) {
            out.push({ depth, tag: 'SHADOW@' + el.tagName + '#' + (el.id || '') });
            scan(el.shadowRoot, depth + 1, out);
          }
        }
      };
      const out = [];
      scan(document, 0, out);
      return {
        videoCount: document.querySelectorAll('video').length,
        out,
        bodyKids: [...document.body.children].map((c) => c.tagName + '#' + (c.id || '')).slice(0, 12),
      };
    });
    console.log(`\nframe ${f.url().slice(0, 60)}:\n`, JSON.stringify(info, null, 1).slice(0, 1200));
  } catch (e) {
    console.log(`\nframe ${f.url().slice(0, 60)}: evaluate error: ${e.message.split('\n')[0]}`);
  }
}
await browser.close();