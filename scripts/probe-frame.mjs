import { chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(BASE);
await page.locator('[role="link"][aria-label]').first().hover();
await page.waitForTimeout(2500);

let megaFrame = null;
for (let i = 0; i < 40 && !megaFrame; i++) {
  megaFrame = page.frames().find((f) => f.url().includes('mega.nz/embed'));
  if (!megaFrame) await page.waitForTimeout(500);
}
console.log('frame url:', megaFrame?.url()?.slice(0, 80));

if (megaFrame) {
  // Recursively scan for <video> elements including inside shadow roots.
  const info = await megaFrame.evaluate(() => {
    const scan = (root, depth, out) => {
      for (const el of root.querySelectorAll('*')) {
        if (el.tagName === 'VIDEO') {
          out.push({ depth, tag: 'VIDEO', id: el.id, cls: el.className });
        }
        if (el.shadowRoot) {
          out.push({ depth, tag: 'SHADOW', host: el.tagName + '#' + (el.id || '') });
          scan(el.shadowRoot, depth + 1, out);
        }
      }
    };
    const out = [];
    scan(document, 0, out);
    return {
      out,
      hasShadowHosts: document.querySelectorAll('*').length - document.querySelectorAll('*:not(:defined)').length,
      bodyChildren: [...document.body.children].map((c) => c.tagName + '#' + (c.id || '') + '.' + String(c.className).slice(0, 40)),
      totalElements: document.querySelectorAll('*').length,
    };
  });
  console.log('frame scan:', JSON.stringify(info, null, 2).slice(0, 2500));
}
await browser.close();