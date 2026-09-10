import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(4000);

for (const f of page.frames()) {
  console.log('frame:', f.url().slice(0, 100), '| name:', f.name());
  try {
    const info = await f.evaluate(() => {
      const scan = (root, depth, out) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.tagName === 'VIDEO') out.push({ depth, tag: 'VIDEO', cls: String(el.className).slice(0, 50) });
          if (el.shadowRoot) { out.push({ depth, tag: 'SHADOW@' + el.tagName }); scan(el.shadowRoot, depth + 1, out); }
        }
      };
      const out = [];
      scan(document, 0, out);
      return {
        n: document.querySelectorAll('*').length,
        out,
        kids: [...document.body.children].map((c) => c.tagName + '#' + (c.id || '') + '.' + String(c.className).slice(0, 30)).slice(0, 14),
      };
    });
    console.log(JSON.stringify(info, null, 1).slice(0, 900));
  } catch (e) {
    console.log('  evaluate failed:', e.message.split('\n')[0]);
  }
  console.log('---');
}
await browser.close();