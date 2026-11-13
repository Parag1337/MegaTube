/**
 * Real browser timeline-preview regression.
 *
 * Verifies the whole chain, not just HTTP 200:
 *   - the authenticated owner can load a private video page;
 *   - PrivatePlayer fetches preview meta, the VTT, and the spritesheet;
 *   - hovering the Vidstack time slider renders a sprite thumbnail and
 *     moves the thumbnail window between VTT cells;
 *   - clicking the slider seeks the actual <video> element;
 *   - the player reports no media error.
 *
 * Set E2E_TIMELINE_VIDEO_SLUG to a ready private video (ideally short, so
 * the media duration is final immediately). Authenticated tests also need
 * CLERK_SECRET_KEY and E2E_CLERK_USER_ID (see ./clerk-auth.mjs). Without
 * either, the test is skipped rather than reported as passed.
 */

import { test, expect } from '@playwright/test';
import { canSignInWithClerk, signInWithClerk } from './clerk-auth.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const SLUG = process.env.E2E_TIMELINE_VIDEO_SLUG ?? '';

test.describe('timeline previews in the real player', () => {
  test.skip(!canSignInWithClerk(), 'requires CLERK_SECRET_KEY and E2E_CLERK_USER_ID');
  test.skip(!SLUG, 'set E2E_TIMELINE_VIDEO_SLUG to a private video with a ready timeline');

  test('hover shows the sprite cell, moves across cues, and click seeks', async ({ page }) => {
    await signInWithClerk(page);

    const vttResponse = page.waitForResponse(
      (r) => r.url().includes('/timeline/vtt') && r.status() === 200,
      { timeout: 30_000 },
    );
    const spriteResponse = page.waitForResponse(
      (r) => /\/api\/preview\/\d+\/timeline$/.test(new URL(r.url()).pathname) && r.status() === 200,
      { timeout: 30_000 },
    );

    await page.goto(`${BASE}/video/${SLUG}`, { waitUntil: 'domcontentloaded' });
    const video = page.locator('video').first();
    await expect(video).toBeVisible({ timeout: 20_000 });

    const vtt = await vttResponse;
    const sprite = await spriteResponse;
    expect(vtt.headers()['content-type']).toContain('text/vtt');
    expect(sprite.headers()['content-type']).toContain('image/jpeg');
    const vttText = await vtt.text();
    expect(vttText.startsWith('WEBVTT')).toBe(true);
    expect(vttText.match(/#xywh=\d+,\d+,\d+,\d+/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

    // The short fixture's duration is final almost immediately; wait for the
    // metadata rather than assuming a fixed load time.
    await expect
      .poll(
        async () =>
          video.evaluate((el) => (Number.isFinite(el.duration) ? el.duration : 0)),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(2);

    const slider = page.locator('.vds-time-slider').first();
    await expect(slider).toBeVisible({ timeout: 20_000 });
    const box = await slider.boundingBox();
    expect(box).toBeTruthy();
    if (!box) throw new Error('time slider has no box');

    const thumbnail = page.locator('.vds-slider-thumbnail img');
    await slider.hover({ position: { x: Math.floor(box.width * 0.2), y: Math.floor(box.height / 2) } });
    await expect(thumbnail).toBeVisible({ timeout: 10_000 });
    await expect(thumbnail).toHaveAttribute('src', /\/api\/preview\/\d+\/timeline$/);
    await expect
      .poll(() => thumbnail.evaluate((img) => img.naturalWidth), {
        timeout: 10_000,
      })
      .toBeGreaterThan(160);

    const cellAt20 = await thumbnail.evaluate((img) => img.style.transform);
    await slider.hover({ position: { x: Math.floor(box.width * 0.8), y: Math.floor(box.height / 2) } });
    await expect
      .poll(() => thumbnail.evaluate((img) => img.style.transform), {
        timeout: 10_000,
      })
      .not.toBe(cellAt20);

    const duration = await video.evaluate((el) => el.duration);
    await slider.click({ position: { x: Math.floor(box.width * 0.7), y: Math.floor(box.height / 2) } });
    await expect
      .poll(() => video.evaluate((el) => el.currentTime), { timeout: 15_000 })
      .toBeGreaterThan(duration * 0.55);
    expect(await video.evaluate((el) => el.error?.code ?? null)).toBeNull();
  });
});
