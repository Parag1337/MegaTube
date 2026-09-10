import { prisma } from '../lib/db';

async function main() {
  // Update the mega account status to SYNCED
  const updated = await prisma.megaAccount.update({
    where: { id: 1 },
    data: { status: 'SYNCED' },
  });

  console.log('Updated mega account status:', updated.status);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());