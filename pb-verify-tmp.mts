import 'dotenv/config';
import crypto from 'node:crypto';
import { chromium } from '@playwright/test';
const BASE = 'http://localhost:3000';
const IDS = process.argv[2] ? process.argv[2].split(',').map(Number) : [627,631,636];
async function main() {
  const { prisma } = await import('/home/parag/Projects/Project_Mega/lib/db');
  const vids = await prisma.video.findMany({ where: { id: { in: IDS } }, select: { id: true, slug: true, megaAccount: { select: { userId: true } } } });
  console.log('videos:', JSON.stringify(vids.map(v=>({id:v.id,slug:v.slug}))));
  const userId = vids[0]?.megaAccount?.userId;
  if (!userId) throw new Error('no user');
  const token = crypto.randomBytes(32).toString('hex');
  await prisma.session.create({ data: { userId, token, expiresAt: new Date(Date.now()+15*60_000) } });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--mute-audio','--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: 'session_token', value: token, url: BASE }]);
  for (const v of vids) {
    const page = await context.newPage();
    const reqs: Array<{range:string|null,status?:number,ms?:number,t:number}> = [];
    const tmap = new Map<string,number>();
    page.on('request', (r) => { if (r.url().includes(`/api/media/${v.id}`) && !r.url().includes('thumbs')) { tmap.set(r.url()+r.headers()['range'], Date.now()); reqs.push({ range: r.headers()['range'] ?? null, t: Date.now() }); } });
    page.on('response', (res) => { if (res.url().includes(`/api/media/${v.id}`) && !res.url().includes('thumbs')) { const e = [...reqs].reverse().find(m=>m.status===undefined); if(e){e.status=res.status(); e.ms=Date.now()-e.t;} } });
    const t0 = Date.now();
    await page.goto(`${BASE}/video/${v.slug}`, { waitUntil: 'domcontentloaded' });
    let meta: unknown = null; let metaMs = -1;
    try {
      await page.waitForFunction(() => { const el = document.querySelector('video'); return el && el.readyState >= 1 && Number.isFinite(el.duration) && el.duration > 0; }, { timeout: 90000 });
      metaMs = Date.now()-t0;
      meta = await page.evaluate(() => { const el = document.querySelector('video')!; return { duration: el.duration, rs: el.readyState, paused: el.paused, muted: el.muted, autoplay: el.autoplay, w: el.videoWidth, h: el.videoHeight }; });
    } catch (e) { meta = { timeout: String(e).slice(0,120) }; }
    // autoplay state shortly after metadata
    await page.waitForTimeout(3000);
    const play = await page.evaluate(() => { const el = document.querySelector('video'); if(!el) return null; return { paused: el.paused, t: el.currentTime, rs: el.readyState, muted: el.muted, buf: el.buffered.length ? { s: el.buffered.start(0), e: el.buffered.end(el.buffered.length-1) } : null, err: el.error ? { c: el.error.code, m: el.error.message } : null }; });
    // progression: sample currentTime twice
    const t1 = (play as {t:number}|null)?.t ?? 0;
    await page.waitForTimeout(4000);
    const play2 = await page.evaluate(() => { const el = document.querySelector('video'); return el ? { paused: el.paused, t: el.currentTime, rs: el.readyState } : null; });
    // seek test
    let seek: unknown = null;
    try {
      await page.evaluate(() => { const el = document.querySelector('video')!; el.currentTime = Math.min(30, (el.duration||60)-5); });
      await page.waitForTimeout(6000);
      seek = await page.evaluate(() => { const el = document.querySelector('video'); return el ? { t: el.currentTime, seeking: el.seeking, rs: el.readyState, paused: el.paused } : null; });
    } catch (e) { seek = { err: String(e).slice(0,100) }; }
    console.log(`VIDEO ${v.id}: metaMs=${metaMs} meta=${JSON.stringify(meta)} play=${JSON.stringify(play)} play2=${JSON.stringify(play2)} seek=${JSON.stringify(seek)} reqs=${JSON.stringify(reqs.slice(0,8))}`);
    await page.close();
  }
  await browser.close();
  await prisma.session.deleteMany({ where: { token } });
  await prisma.$disconnect();
}
main().then(()=>process.exit(0),(e)=>{console.error('FAIL',e);process.exit(1);});
