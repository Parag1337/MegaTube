/**
 * E2E test for the MEGA embed + hover preview system.
 *
 * Requirements verified:
 *  - no preview surfaces (iframe or local clip) on page load
 *  - hover -> ~400ms delay -> exactly one preview: local /api/preview clip
 *    (Phase 5) or the legacy MEGA embed iframe fallback
 *  - local clips are muted + playing; iframe paths still stream MEGA chunks
 *  - mouseleave destroys the preview, thumbnail back
 *  - only one preview surface at a time
 *  - click navigates to /video/<slug> in the CURRENT tab (no popup)
 *  - video page player uses the normal (non-autoplay) embed URL
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/** Either preview implementation counts as one preview surface. */
function previewSurfaces(page) {
  return page.locator(
    'iframe[src*="mega.nz/embed"], [role="link"][aria-label] video[src^="/api/preview/"]',
  );
}

/**
 * Optional authenticated E2E: the app's pages are Clerk-protected, and the
 * legacy session cookie alone does not satisfy Clerk middleware. CI can set
 * E2E_SESSION_TOKEN (plus a middleware bypass) to exercise a real library.
 * Without it the suite runs exactly as before (public/landing environment).
 */
const SESSION_TOKEN = process.env.E2E_SESSION_TOKEN;
test.beforeEach(async ({ context }) => {
  if (SESSION_TOKEN) {
    await context.addCookies([
      { name: 'session_token', value: SESSION_TOKEN, url: BASE, httpOnly: true, sameSite: 'Lax' },
    ]);
  }
});

test.describe('homepage preview system', () => {
  test('renders cards without preview surfaces', async ({ page }) => {
    await page.goto(BASE);
    const cards = page.locator('[role="link"][aria-label]');
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(previewSurfaces(page)).toHaveCount(0);
  });

  test('hover starts exactly one muted/autoplay preview after a short delay', async ({ page }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();
    const surfaces = previewSurfaces(page);

    await expect(surfaces).toHaveCount(0);

    const videoRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('userstorage.mega.co.nz')) videoRequests.push(req.url());
    });

    await firstCard.hover();
    await page.waitForTimeout(150);
    await expect(surfaces).toHaveCount(0);

    // Local cold previews poll until generation completes; allow that window.
    await expect(surfaces).toHaveCount(1, { timeout: 30000 });
    const tag = await surfaces.first().evaluate((el) => el.tagName);

    if (tag === 'VIDEO') {
      const video = surfaces.first();
      expect(await video.getAttribute('src')).toMatch(/^\/api\/preview\/\d+$/);
      await expect
        .poll(async () => video.evaluate((el) => el.currentTime), { timeout: 15000 })
        .toBeGreaterThan(0);
      expect(await video.evaluate((el) => ({ muted: el.muted, paused: el.paused, loop: el.loop }))).toEqual({
        muted: true,
        paused: false,
        loop: true,
      });
    } else {
      const src = await surfaces.first().getAttribute('src');
      expect(src).toMatch(/^https:\/\/mega\.nz\/embed\/[A-Za-z0-9_-]{8}#[A-Za-z0-9_-]+!1a1m$/);
      await expect
        .poll(() => videoRequests.length, { timeout: 25000 })
        .toBeGreaterThan(0);
    }

    await page.screenshot({ path: '/tmp/preview-active.png' });
  });

  test('mouseleave destroys the preview and shows the thumbnail', async ({ page }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();
    const surfaces = previewSurfaces(page);

    await firstCard.hover();
    await expect(surfaces).toHaveCount(1, { timeout: 30000 });

    await page.mouse.move(0, 0);
    await expect(surfaces).toHaveCount(0);
  });

  test('moving between cards keeps only one preview at a time', async ({ page }) => {
    await page.goto(BASE);
    const cards = page.locator('[role="link"][aria-label]');
    const surfaces = previewSurfaces(page);
    const a = cards.nth(0);
    const b = cards.nth(1);

    await a.hover();
    await expect(surfaces).toHaveCount(1, { timeout: 30000 });
    const aPreview = surfaces.first();
    const aKey = (await aPreview.getAttribute('src')) ?? '';
    expect(aKey).toBeTruthy();

    await b.hover();
    await expect(surfaces).toHaveCount(1, { timeout: 30000 });
    const bPreview = surfaces.first();
    const bKey = (await bPreview.getAttribute('src')) ?? '';
    expect(bKey).toBeTruthy();

    // The one surface now belongs to card B; compare file IDs/sources when
    // both cards use the same implementation.
    expect(bKey).not.toBe(aKey);
  });

  test('clicking a card navigates the current tab to the video page (no popup)', async ({ page, context }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();
    const aria = await firstCard.getAttribute('aria-label');
    expect(aria).toBeTruthy();

    const pagesBefore = context.pages().length;
    let popupOpened = false;
    context.on('page', () => {
      popupOpened = true;
    });

    await firstCard.click({ position: { x: 100, y: 80 } });
    await page.waitForURL(/\/video\//, { timeout: 15000 });
    expect(page.url()).toContain('/video/');

    // Regression: the card used to call window.open(..., '_blank').
    expect(context.pages().length).toBe(pagesBefore);
    expect(popupOpened).toBe(false);

    // Same-tab history works: Back returns to the listing.
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`^${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));
  });
});

test.describe('local hover previews', () => {
  test('hover plays the local clip while it stays on the card', async ({ page, context }) => {
    await page.goto(BASE);
    const card = page.locator('[role="link"][aria-label]').first();
    await expect(card).toBeVisible({ timeout: 15000 });

    const metaResponse = page.waitForResponse(
      (r) => r.url().includes('/api/preview/') && r.url().includes('/meta'),
      { timeout: 20000 },
    );
    await card.hover();
    const meta = await (await metaResponse).json();
    test.skip(
      meta.status !== 'ready' && meta.status !== 'generating',
      `preview not available in this environment: ${meta.status}`,
    );

    // Cold generation is background work; the card polls while hovered.
    const video = card.locator('video[src^="/api/preview/"]');
    await expect(video).toHaveCount(1, { timeout: 45000 });
    await expect
      .poll(async () => video.evaluate((el) => el.currentTime), { timeout: 15000 })
      .toBeGreaterThan(0);
    const state = await video.evaluate((el) => ({
      muted: el.muted,
      paused: el.paused,
      readyState: el.readyState,
      src: el.getAttribute('src'),
    }));
    expect(state.muted).toBe(true);
    expect(state.paused).toBe(false);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
    expect(state.src).toMatch(/^\/api\/preview\/\d+$/);
    expect(context.pages().length).toBe(1);

    // Leaving unmounts the clip.
    await page.mouse.move(0, 0);
    await expect(card.locator('video')).toHaveCount(0);
  });
});

test.describe('same-tab navigation from every listing', () => {
  test('listing clicks stay in the current tab (no popup/window)', async ({ page, context }) => {
    test.skip(!SESSION_TOKEN, 'requires E2E_SESSION_TOKEN for authenticated listings');
    await page.goto(BASE);
    const first = page.locator('[role="link"][aria-label]').first();
    await expect(first).toBeVisible({ timeout: 15000 });

    // Seed watchlist/saved/history for the first card's video so every
    // authenticated listing has a predictable target.
    const metaResponse = page.waitForResponse(
      (r) => /\/api\/preview\/\d+\/meta/.test(r.url()),
      { timeout: 20000 },
    );
    await first.hover();
    const meta = await (await metaResponse).json();
    const videoId = meta.videoId;
    expect(typeof videoId).toBe('number');
    for (const route of ['watchlist', 'saved', 'history']) {
      const res = await page.request.post(`${BASE}/api/${route}/${videoId}`);
      expect(res.ok()).toBe(true);
    }

    const listings = [
      { name: 'homepage', path: '/' },
      { name: 'search', path: '/search?q=the' },
      { name: 'library', path: '/library' },
      { name: 'creator', path: '/creator/unknown-creator' },
      { name: 'watchlist', path: '/watchlist' },
      { name: 'saved', path: '/account/saved' },
      { name: 'history', path: '/account/history' },
    ];

    let visited = 0;
    for (const listing of listings) {
      await page.goto(`${BASE}${listing.path}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700); // let hydration attach the card handlers
      const cards = page.locator('[role="link"][aria-label]');
      const anchors = page.locator('a[href^="/video/"]');
      const target = (await cards.count()) > 0 ? cards.first() : anchors.first();
      if ((await target.count()) === 0) {
        console.log(`[nav-matrix] ${listing.name}: no video target in this environment`);
        continue;
      }
      await expect(target).toBeVisible({ timeout: 10000 });

      const pagesBefore = context.pages().length;
      let popupOpened = false;
      const onPage = () => {
        popupOpened = true;
      };
      context.on('page', onPage);
      await target.click();
      await page.waitForURL((url) => url.pathname.startsWith('/video/'), { timeout: 15000 });
      await page.waitForTimeout(250);
      context.off('page', onPage);

      expect(context.pages().length, `${listing.name} must stay in the current tab`).toBe(pagesBefore);
      expect(popupOpened, `${listing.name} must not call window.open`).toBe(false);
      visited++;

      await page.goBack();
      await expect(page).not.toHaveURL(/\/video\//, { timeout: 10000 });
      await page.waitForTimeout(300);
    }

    expect(visited, 'at least the five always-seeded listings must be covered').toBeGreaterThanOrEqual(5);
  });
});

test.describe('video page', () => {
  test('watch player uses normal playback (never the !1a1m hover embed)', async ({ page }) => {
    await page.goto(BASE);
    const firstCard = page.locator('[role="link"][aria-label]').first();
    await firstCard.click({ position: { x: 100, y: 80 } });
    await page.waitForURL(/\/video\//, { timeout: 15000 });

    const iframe = page.locator('iframe[src*="mega.nz/embed"]');
    const localPlayer = page.locator('video');
    await expect(iframe.or(localPlayer).first()).toBeVisible({ timeout: 15000 });

    if ((await iframe.count()) > 0) {
      const src = await iframe.first().getAttribute('src');
      expect(src).toMatch(/^https:\/\/mega\.nz\/embed\/[A-Za-z0-9_-]{8}#[A-Za-z0-9_-]+$/);
      expect(src).not.toContain('!1a1m');
    } else {
      // Owned/private videos stream through the normal media player.
      await expect(localPlayer.first()).toBeVisible();
    }
  });
});