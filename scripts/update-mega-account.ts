import { prisma } from '../lib/db';

async function main() {
  const email = 'test@example.com';

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.log('User not found');
    return;
  }

  // Update the existing mega account to be owned by the test user
  const updated = await prisma.megaAccount.updateMany({
    where: { id: 1 },
    data: { userId: user.id },
  });

  console.log('Updated mega account count:', updated.count);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());