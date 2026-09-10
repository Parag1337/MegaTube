import { prisma } from '../lib/db';

async function main() {
  const account = await prisma.megaAccount.findUnique({
    where: { id: 1 },
    select: {
      id: true,
      userId: true,
      label: true,
      megaEmail: true,
      status: true,
      lastSyncCompletedAt: true,
      lastSyncError: true,
      consecutiveSyncFailures: true,
      videoCount: true,
    },
  });

  console.log('MEGA Account status:');
  console.table(account);

  // Check some videos
  const videos = await prisma.video.findMany({
    where: { megaAccountId: 1 },
    select: {
      id: true,
      title: true,
      megaNodeId: true,
      fileKeyEncrypted: true,
    },
    take: 5,
  });

  console.log('\nSample videos from this account:');
  console.table(videos);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());