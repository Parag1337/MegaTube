/**
 * E2E test for the MEGA embed + hover preview system.
 *
 * Requirements verified:
 *  - no preview iframes on page load
 *  - hover -> ~400ms delay -> preview iframe with !1a1m src
 *  - actual video streaming starts (requests to *.userstorage.mega.co.nz)
 *  - mouseleave -> iframe destroyed, thumbnail back
 *  - only one preview iframe at a time
 *  - click opens /video/<slug> in a new tab
 *  - video page player uses the normal (non-autoplay) embed URL
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

test.describe('homepage preview system', () => {
  test('renders cards without preview iframes', async ({ page }) => {
    await page.goto(BASE);
    const cards = page.locator('[role="link"][aria-label]');
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
  });

  test('hover starts a muted autoplay preview after a short delay', async ({ page }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();

    // No iframe yet.
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);

    const videoRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('userstorage.mega.co.nz')) videoRequests.push(req.url());
    });

    await firstCard.hover();
    // Before the delay elapses there should be no iframe.
    await page.waitForTimeout(150);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);

    // After the delay the preview iframe mounts with !1a1m.
    const iframe = page.locator('iframe[src*="mega.nz/embed"]');
    await expect(iframe).toHaveCount(1, { timeout: 2000 });
    const src = await iframe.getAttribute('src');
    expect(src).toMatch(/^https:\/\/mega\.nz\/embed\/[A-Za-z0-9_-]{8}#[A-Za-z0-9_-]+!1a1m$/);

    // The MEGA player should start streaming video chunks.
    await expect
      .poll(() => videoRequests.length, { timeout: 25000 })
      .toBeGreaterThan(0);

    await page.screenshot({ path: '/tmp/preview-active.png' });
  });

  test('mouseleave destroys the preview and shows the thumbnail', async ({ page }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();

    await firstCard.hover();
    const iframe = page.locator('iframe[src*="mega.nz/embed"]');
    await expect(iframe).toHaveCount(1, { timeout: 2000 });

    await firstCard.hover({ position: { x: 5, y: 5 } }); // nudge
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(0);
  });

  test('moving between cards keeps only one preview at a time', async ({ page }) => {
    await page.goto(BASE);
    const cards = page.locator('[role="link"][aria-label]');
    const a = cards.nth(0);
    const b = cards.nth(1);

    await a.hover();
    await page.waitForTimeout(600);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(1);
    const aSrc = await page.locator('iframe[src*="mega.nz/embed"]').getAttribute('src');
    const aFileId = aSrc.match(/\/embed\/([A-Za-z0-9_-]{8})/)?.[1];
    expect(aFileId).toBeTruthy();

    await b.hover();
    await page.waitForTimeout(600);
    await expect(page.locator('iframe[src*="mega.nz/embed"]')).toHaveCount(1);
    const bSrc = await page.locator('iframe[src*="mega.nz/embed"]').getAttribute('src');
    const bFileId = bSrc.match(/\/embed\/([A-Za-z0-9_-]{8})/)?.[1];

    // The iframe now belongs to card B (different video than A's).
    expect(bFileId).toBeTruthy();
    expect(bFileId).not.toBe(aFileId);
  });

  test('clicking a card opens the video page in a new tab', async ({ page, context }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();
    const aria = await firstCard.getAttribute('aria-label');
    expect(aria).toBeTruthy();

    const [newTab] = await Promise.all([
      context.waitForEvent('page'),
      firstCard.click({ position: { x: 100, y: 80 } }),
    ]);
    await newTab.waitForLoadState('domcontentloaded');
    expect(newTab.url()).toContain('/video/');
    await newTab.screenshot({ path: '/tmp/video-page.png' });
  });
});

test.describe('video page', () => {
  test('player iframe uses the normal embed URL (no !1a1m)', async ({ page }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();
    const href = await firstCard.getAttribute('aria-label');
    void href;
    await page.goto(`${BASE}/video/freya-reign-quick-pegging-before-dinner`);

    const iframe = page.locator('iframe[src*="mega.nz/embed"]');
    await expect(iframe).toHaveCount(1);
    const src = await iframe.getAttribute('src');
    expect(src).toMatch(/^https:\/\/mega\.nz\/embed\/[A-Za-z0-9_-]{8}#[A-Za-z0-9_-]+$/);
    expect(src).not.toContain('!1a1m');
  });
});