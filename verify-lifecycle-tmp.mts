/** Subscriber-lifecycle browser verification: abandon / slot-recovery / multi-viewer / grace-return. */
import crypto from 'node:crypto';
import { chromium, type Browser, type BrowserContext } from '@playwright/test';
const BASE = 'http://localhost:3000';
let BROWSER: Browser;
let CTX: BrowserContext;
let TOKEN: string;

async function db() {
  return import('/home/parag/Projects/Project_Mega/lib/db');
}
async function slug(id: number): Promise<string> {
  const { prisma } = await db();
  const v = await prisma.video.findUnique({ where: { id }, select: { slug: true } });
  await prisma.$disconnect();
  return v!.slug;
}
async function newPage(id: number) {
  const page = await CTX.newPage();
  const reqs: string[] = [];
  page.on('response', (res) => {
    if (res.url().includes(`/api/media/${id}`) && !res.url().includes('thumbs')) {
      reqs.push(`${res.status()}@${res.request().headers()['range'] ?? 'none'}#${res.headers()['x-media-path'] ?? '?'}`);
    }
  });
  page.on('console', (m) => {
    if (/PIPELINE|demuxer/i.test(m.text())) console.log(`  [${id} MEDIA-ERR]`, m.text().slice(0, 130));
  });
  return { page, reqs };
}
async function gotoPlay(page: import('@playwright/test').Page, id: number, s: string, playTimeout = 90000) {
  await page.goto(`${BASE}/video/${s}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 3; }, { timeout: playTimeout });
  await page.evaluate(() => { const el = document.querySelector('video')!; void el.play().catch(() => {}); });
  await page.waitForTimeout(5000);
  return page.evaluate(() => { const el = document.querySelector('video')!; return { t: +el.currentTime.toFixed(1), rs: el.readyState, paused: el.paused }; });
}

async function main() {
  const { prisma } = await db();
  const anchor = await prisma.video.findUnique({ where: { id: 627 }, select: { megaAccount: { select: { userId: true } } } });
  TOKEN = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { userId: anchor!.megaAccount!.userId, token: TOKEN, expiresAt: new Date(Date.now() + 30 * 60_000) } });
  await prisma.$disconnect();
  BROWSER = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  CTX = await BROWSER.newContext();
  await CTX.addCookies([{ name: 'session_token', value: TOKEN, url: BASE }]);
  const phase = process.argv[2] ?? 'all';

  if (phase === 'all' || phase === 'B') {
    console.log('PHASE B: abandon cold 631, expect cancel after grace');
    const { page, reqs } = await newPage(631);
    const st = await gotoPlay(page, 631, await slug(631));
    console.log('  playing:', JSON.stringify(st), 'reqs:', JSON.stringify(reqs.slice(0, 3)));
    const tClose = Date.now();
    await page.close();
    console.log(`  closed at +0s; waiting 25s past grace...`);
    await new Promise((r) => setTimeout(r, 25000));
    console.log(`  B done (closed ${(Date.now() - tClose) / 1000}s ago)`);
  }
  if (phase === 'all' || phase === 'C') {
    console.log('PHASE C: abandon 627+631 (both slots), then cold 633 must start');
    const p1 = await newPage(627);
    const p2 = await newPage(631);
    await Promise.all([p1.page.goto(`${BASE}/video/${await slug(627)}`, { waitUntil: 'domcontentloaded' }), p2.page.goto(`${BASE}/video/${await slug(631)}`, { waitUntil: 'domcontentloaded' })]);
    await Promise.all([
      p1.page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 3; }, { timeout: 90000 }).catch(() => 't1-timeout'),
      p2.page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 3; }, { timeout: 90000 }).catch(() => 't2-timeout'),
    ]);
    console.log('  both cold jobs running; abandoning both now');
    await Promise.all([p1.page.close(), p2.page.close()]);
    console.log('  waiting 25s (grace + teardown)...');
    await new Promise((r) => setTimeout(r, 25000));
    const { page, reqs } = await newPage(633);
    const st = await gotoPlay(page, 633, await slug(633)).catch((e) => ({ fail: String(e).slice(0, 120) }));
    console.log('  633 start:', JSON.stringify(st), 'reqs:', JSON.stringify(reqs.slice(0, 4)));
    await page.close();
  }
  if (phase === 'all' || phase === 'D') {
    console.log('PHASE D: two tabs same cold 627, close one, other must continue');
    const t1 = await newPage(627);
    const t2 = await newPage(627);
    await t1.page.goto(`${BASE}/video/${await slug(627)}`, { waitUntil: 'domcontentloaded' });
    await t1.page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 3; }, { timeout: 90000 });
    await t2.page.goto(`${BASE}/video/${await slug(627)}`, { waitUntil: 'domcontentloaded' });
    await t2.page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 3; }, { timeout: 90000 });
    console.log('  both tabs playing; closing tab1');
    await t1.page.close();
    await t2.page.waitForTimeout(12000);
    const st = await t2.page.evaluate(() => { const el = document.querySelector('video')!; return { t: +el.currentTime.toFixed(1), rs: el.readyState, paused: el.paused, err: el.error?.code ?? null }; });
    console.log('  tab2 after tab1 closed 12s:', JSON.stringify(st), 'reqs:', JSON.stringify(t2.reqs.slice(0, 5)));
    await t2.page.close();
  }
  if (phase === 'all' || phase === 'E') {
    console.log('PHASE E: reopen within grace must join the same job');
    const e1 = await newPage(631);
    await e1.page.goto(`${BASE}/video/${await slug(631)}`, { waitUntil: 'domcontentloaded' });
    await e1.page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 3; }, { timeout: 90000 });
    console.log('  playing; closing, reopening in 4s (inside grace)');
    await e1.page.close();
    await new Promise((r) => setTimeout(r, 4000));
    const e2 = await newPage(631);
    const t0 = Date.now();
    const st = await gotoPlay(e2.page, 631, await slug(631));
    console.log(`  rejoined in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(st), 'reqs:', JSON.stringify(e2.reqs.slice(0, 4)));
    await e2.page.close();
  }
  await BROWSER.close();
  const { prisma: p2 } = await db();
  await p2.session.deleteMany({ where: { token: TOKEN } });
  await p2.$disconnect();
}
main().then(() => process.exit(0), (e) => { console.error('FAIL', e); process.exit(1); });
