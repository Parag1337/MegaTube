import 'dotenv/config';
import crypto from 'node:crypto';
const BASE = 'http://localhost:3000';
const { prisma } = await import('./lib/db');
const account = await prisma.megaAccount.findUnique({ where: { id: 1 }, select: { userId: true } });
const token = crypto.randomBytes(32).toString('hex');
await prisma.session.create({ data: { userId: account!.userId, token, expiresAt: new Date(Date.now() + 10*60_000) } });
const v = await prisma.video.findUnique({ where: { id: 26 }, select: { id: true, slug: true, megaAccountId: true } });
console.log('video26:', JSON.stringify(v));
// whoami via a lightweight authenticated endpoint
for (const p of ['/api/watchlist', '/api/history']) {
  const r = await fetch(`${BASE}${p}`, { headers: { cookie: `session_token=${token}` } });
  console.log(p, '->', r.status);
}
await prisma.session.deleteMany({ where: { token } });
await prisma.$disconnect();
