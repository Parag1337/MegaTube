import { prisma } from '../lib/db';

async function main() {
  const videos = await prisma.video.findMany({
    select: {
      id: true,
      title: true,
      megaFilename: true,
      fileSize: true,
      mimeType: true,
      megaAccountId: true,
      slug: true,
      megaNodeId: true,
    },
    take: 20,
  });

  console.log('Videos in database:');
  console.table(videos);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());