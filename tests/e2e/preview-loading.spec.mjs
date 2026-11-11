/**
 * Phase 5 loading-indicator regressions.
 *
 * These tests pin the visible lifecycle on the real card component:
 * cold metadata shows the badge, `generating` keeps it, success waits for
 * actual playback, cached previews never flash it, and terminal/error/timeout
 * paths remove it. API responses are mocked where a deterministic failure is
 * required; the ready/cached paths use the real preview endpoint.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const META_RE = /\/api\/preview\/(\d+)\/meta\?want=hover$/;

const SESSION_TOKEN = process.env.E2E_SESSION_TOKEN;
test.beforeEach(async ({ context }) => {
  if (SESSION_TOKEN) {
    await context.addCookies([
      { name: 'session_token', value: SESSION_TOKEN, url: BASE, httpOnly: true, sameSite: 'Lax' },
    ]);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cards(page) {
  return page.locator('[role="link"][aria-label]');
}

function firstCard(page) {
  return cards(page).first();
}

function loader(card) {
  return card.locator('[data-preview-loading]');
}

function localVideo(card) {
  return card.locator('video[src^="/api/preview/"]');
}

function idFromMetaUrl(url) {
  return Number(url.match(META_RE)?.[1] ?? 0);
}

function generating(id) {
  return { videoId: id, status: 'generating', hover: null, timeline: null };
}

function terminal(id) {
  return { videoId: id, status: 'unavailable', hover: null, timeline: null };
}

function ready(id, url) {
  return { videoId: id, status: 'ready', hover: { url }, timeline: null };
}

async function gotoHome(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await expect(firstCard(page)).toBeVisible({ timeout: 20_000 });
}

async function routeMeta(page, handler) {
  await page.route(META_RE, async (route) => {
    const id = idFromMetaUrl(route.request().url());
    await handler(route, id);
  });
}

async function cardFirstId(card) {
  const src = await card.locator('img').first().getAttribute('src');
  return Number(src?.match(/\/api\/media\/thumbs\/(\d+)/)?.[1] ?? 0);
}

/**
 * The ready/cached paths use the live preview endpoint so the test exercises
 * the real clip and real playback. Skip only when this environment has no
 * generated clip yet (the same limitation as the main preview suite).
 */
async function readyCard(page) {
  const card = firstCard(page);
  const id = await cardFirstId(card);
  if (!id) test.skip(true, 'first card has no media id');
  const res = await page.request.get(`${BASE}/api/preview/${id}/meta?want=hover`);
  if (!res.ok()) test.skip(true, `preview meta unavailable (${res.status()})`);
  const meta = await res.json();
  test.skip(meta.status !== 'ready' || !meta.hover?.url, `preview not ready: ${meta.status}`);
  return { card, id, url: meta.hover.url };
}

test.describe('hover preview loading indicator', () => {
  test('cold metadata shows the loading indicator while the request is in flight', async ({ page }) => {
    await gotoHome(page);
    const card = firstCard(page);
    const badge = loader(card);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    await routeMeta(page, async (route, id) => {
      await gate;
      await route.fulfill({ json: generating(id) });
    });

    const metaRequest = page.waitForRequest(META_RE);
    await card.hover();
    await metaRequest;

    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toContainText('Loading preview');
    await expect(badge).toHaveAttribute('role', 'status');
    await expect(badge).toHaveCSS('position', 'absolute');
    await expect(badge).toHaveCSS('pointer-events', 'none');

    release();
    await page.waitForResponse(META_RE);
    await expect(badge).toBeVisible();

    await page.mouse.move(5, 5);
    await expect(badge).toHaveCount(0);
  });

  test('generating status keeps the indicator visible through polling', async ({ page }) => {
    await gotoHome(page);
    const card = firstCard(page);
    const badge = loader(card);
    let metaRequests = 0;
    page.on('request', (request) => {
      if (META_RE.test(request.url())) metaRequests++;
    });
    await routeMeta(page, (route, id) => route.fulfill({ json: generating(id) }));

    await card.hover();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(2_600);
    await expect(badge).toBeVisible();
    expect(metaRequests).toBeGreaterThanOrEqual(2);

    await page.mouse.move(5, 5);
    await expect(badge).toHaveCount(0);
  });

  test('ready preview removes the indicator after playback begins', async ({ page }) => {
    await gotoHome(page);
    const { card, id, url } = await readyCard(page);
    const badge = loader(card);
    const video = localVideo(card);

    await routeMeta(page, async (route) => {
      await sleep(700);
      await route.fulfill({ json: ready(id, url) });
    });

    await card.hover();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => video.evaluate((el) => el.currentTime), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expect(badge).toHaveCount(0);
    expect(await video.evaluate((el) => ({ muted: el.muted, paused: el.paused, loop: el.loop }))).toEqual({
      muted: true,
      paused: false,
      loop: true,
    });
  });

  test('cached preview does not flash the loading indicator', async ({ page }) => {
    await gotoHome(page);
    const { card } = await readyCard(page);
    const video = localVideo(card);

    await card.hover();
    await expect(video).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => video.evaluate((el) => el.currentTime), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await page.mouse.move(5, 5);
    await expect(video).toHaveCount(0);

    await page.evaluate(() => {
      window.__p5LoaderSeen = false;
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-preview-loading]')) {
          window.__p5LoaderSeen = true;
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      window.__p5LoaderObserver = observer;
    });

    let metaRequests = 0;
    page.on('request', (request) => {
      if (META_RE.test(request.url())) metaRequests++;
    });

    await card.hover();
    await expect(video).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(700);

    expect(await page.evaluate(() => window.__p5LoaderSeen)).toBe(false);
    expect(metaRequests, 'cached hover must reuse the page-lifetime meta cache').toBe(0);
    await expect(loader(card)).toHaveCount(0);
  });

  test('failed generation removes the indicator and keeps the thumbnail', async ({ page }) => {
    await gotoHome(page);
    const card = firstCard(page);
    const badge = loader(card);
    await routeMeta(page, (route, id) => route.fulfill({ json: terminal(id) }));

    await card.hover();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toHaveCount(0, { timeout: 6_000 });
    await expect(card.locator('img').first()).toBeVisible();
    await expect(localVideo(card)).toHaveCount(0);
  });

  test('polling timeout removes the indicator and keeps the fallback path', async ({ page }) => {
    test.slow();
    await gotoHome(page);
    const card = firstCard(page);
    const badge = loader(card);
    let metaRequests = 0;
    page.on('request', (request) => {
      if (META_RE.test(request.url())) metaRequests++;
    });
    await routeMeta(page, (route, id) => route.fulfill({ json: generating(id) }));

    await card.hover();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toHaveCount(0, { timeout: 38_000 });
    expect(metaRequests).toBeGreaterThanOrEqual(2);
    await expect(card.locator('img').first()).toBeVisible();
    await expect(localVideo(card)).toHaveCount(0);
  });

  test('leaving during a cold request removes the indicator and ignores the stale response', async ({ page }) => {
    await gotoHome(page);
    const card = firstCard(page);
    const badge = loader(card);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    await routeMeta(page, async (route, id) => {
      await gate;
      await route.fulfill({ json: generating(id) });
    });

    const metaRequest = page.waitForRequest(META_RE);
    await card.hover();
    await metaRequest;
    await expect(badge).toBeVisible({ timeout: 5_000 });

    await page.mouse.move(5, 5);
    await expect(badge).toHaveCount(0);

    const response = page.waitForResponse(META_RE);
    release();
    await response;
    await page.waitForTimeout(500);
    await expect(badge).toHaveCount(0);
  });

  test('rapid card switching leaves only the current card loading', async ({ page }) => {
    await gotoHome(page);
    const all = cards(page);
    const a = all.nth(0);
    const b = all.nth(1);
    await routeMeta(page, async (route, id) => {
      await sleep(1_200);
      await route.fulfill({ json: generating(id) });
    });

    await a.hover();
    await expect(loader(a)).toBeVisible({ timeout: 5_000 });

    await b.hover();
    await expect(loader(b)).toBeVisible({ timeout: 5_000 });
    await expect(loader(a)).toHaveCount(0);
    await expect(page.locator('[data-preview-loading]')).toHaveCount(1);

    await page.mouse.move(5, 5);
    await expect(page.locator('[data-preview-loading]')).toHaveCount(0);
  });

  test('indicator lets card clicks through and navigates in the same tab', async ({ page, context }) => {
    await gotoHome(page);
    const card = firstCard(page);
    const badge = loader(card);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    await routeMeta(page, async (route, id) => {
      await gate;
      await route.fulfill({ json: generating(id) }).catch(() => {});
    });

    await card.hover();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toHaveCSS('pointer-events', 'none');
    const box = await badge.boundingBox();
    expect(box).toBeTruthy();

    const pagesBefore = context.pages().length;
    let popupOpened = false;
    context.on('page', () => {
      popupOpened = true;
    });

    // Clicking the badge's own coordinates must hit the card underneath.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForURL((url) => url.pathname.startsWith('/video/'), { timeout: 15_000 });
    expect(context.pages().length).toBe(pagesBefore);
    expect(popupOpened).toBe(false);

    release();
    await page.waitForTimeout(100);
  });

  test('HTTP metadata errors stop the indicator', async ({ page }) => {
    await gotoHome(page);
    const card = firstCard(page);
    const badge = loader(card);
    await routeMeta(page, (route) => route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'preview backend down' }),
    }));

    await card.hover();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toHaveCount(0, { timeout: 6_000 });
    await expect(card.locator('img').first()).toBeVisible();
  });

  test('media playback errors stop the indicator and local clip', async ({ page }) => {
    await gotoHome(page);
    const card = firstCard(page);
    const id = await cardFirstId(card);
    if (!id) test.skip(true, 'first card has no media id');
    const badge = loader(card);

    await page.route(new RegExp(`/api/preview/${id}$`), async (route) => {
      // Keep the loader up long enough to observe before the media error.
      await sleep(700);
      await route.fulfill({
        status: 500,
        contentType: 'text/plain',
        body: 'preview clip unavailable',
      });
    });
    await routeMeta(page, async (route) => {
      await sleep(500);
      await route.fulfill({ json: ready(id, `/api/preview/${id}`) });
    });

    await card.hover();
    await expect(badge).toBeVisible({ timeout: 5_000 });
    await expect(badge).toHaveCount(0, { timeout: 6_000 });
    await expect(localVideo(card)).toHaveCount(0);
    await expect(card.locator('img').first()).toBeVisible();
  });
});
