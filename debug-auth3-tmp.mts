import 'dotenv/config';
const BASE = 'http://localhost:3000';
const { prisma } = await import('./lib/db');
// Use the REAL login endpoint like a browser would
const user = await prisma.user.findFirst({ select: { email: true } });
console.log('login as:', user?.email);
const r = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: user!.email, password: 'wrong' }),
});
console.log('login wrong-pw ->', r.status);
console.log('set-cookie:', r.headers.get('set-cookie')?.slice(0,120));
await prisma.$disconnect();
