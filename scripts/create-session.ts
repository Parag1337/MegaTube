import { prisma } from '../lib/db';
import { randomBytes } from 'crypto';

async function main() {
  const email = 'test@example.com';

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.log('User not found');
    return;
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 60 * 60 * 24 * 7 * 1000); // 7 days

  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt,
    },
  });

  console.log('Session token:', token);
  console.log('Use this as the session_token cookie value');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());