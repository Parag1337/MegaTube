/** Slot-recovery proof on untouched-cold videos (deleted after use). */
import crypto from 'node:crypto';
import { chromium, type Browser } from '@playwright/test';
const BASE = 'http://localhost:3000';
async function db() { return import('/home/parag/Projects/Project_Mega/lib/db'); }
async function playTo(browser: import('@playwright/test').Browser, id: number) {
  const { prisma } = await db();
  const v = await prisma.video.findUnique({ where: { id }, select: { slug: true, megaAccount: { select: { userId: true } } } });
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { userId: v!.megaAccount!.userId, token, expiresAt: new Date(Date.now() + 30 * 60_000) } });
  await prisma.$disconnect();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'session_token', value: token, url: BASE }]);
  const page = await ctx.newPage();
  const reqs: string[] = [];
  page.on('response', (res) => {
    if (res.url().includes(`/api/media/${id}`) && !res.url().includes('thumbs')) {
      reqs.push(`${res.status()}@${res.request().headers()['range'] ?? 'none'}#${res.headers()['x-media-path'] ?? '?'}`);
    }
  });
  await page.goto(`${BASE}/video/${v!.slug}`, { waitUntil: 'domcontentloaded' });
  const ok = await page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 3; }, { timeout: 90000 }).then(() => true).catch(() => false);
  return { page, reqs, ok, token };
}
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  const tokens: string[] = [];
  console.log('opening 18 + 22 cold (occupying both slots)...');
  const a = await playTo(browser, 18);
  const b = await playTo(browser, 22);
  tokens.push(a.token, b.token);
  console.log('18:', a.ok, JSON.stringify(a.reqs.slice(0, 2)), '22:', b.ok, JSON.stringify(b.reqs.slice(0, 2)));
  console.log('abandoning both NOW; waiting 25s...');
  await Promise.all([a.page.context().close(), b.page.context().close()]);
  await new Promise((r) => setTimeout(r, 25000));
  console.log('opening cold 21 (must start: 200-live, NOT 503 pool-saturated)...');
  const c = await playTo(browser, 21);
  tokens.push(c.token);
  console.log('21:', c.ok, JSON.stringify(c.reqs.slice(0, 4)));
  await c.page.context().close();
  await browser.close();
  const { prisma } = await db();
  await prisma.session.deleteMany({ where: { token: { in: tokens } } });
  await prisma.$disconnect();
}
main().then(() => process.exit(0), (e) => { console.error('FAIL', e); process.exit(1); });
