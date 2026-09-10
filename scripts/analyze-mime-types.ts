import { prisma } from '../lib/db';

async function main() {
  // Analyze MIME types distribution
  const videos = await prisma.video.findMany({
    where: { megaAccountId: { not: null } },
    select: {
      id: true,
      title: true,
      mimeType: true,
      fileSize: true,
    },
  });

  const mimeGroups = videos.reduce((acc, video) => {
    const mime = video.mimeType || 'unknown';
    if (!acc[mime]) {
      acc[mime] = [];
    }
    acc[mime].push(video);
    return acc;
  }, {} as Record<string, typeof videos>);

  console.log('MIME type distribution:');
  for (const [mime, vids] of Object.entries(mimeGroups)) {
    console.log(`\n${mime}: ${vids.length} videos`);
    console.log('Sample videos:');
    console.table(vids.slice(0, 3).map(v => ({
      id: v.id,
      title: v.title,
      size: Number(v.fileSize) / 1024 / 1024 + ' MB',
    })));
  }

  console.log('\n=== SUMMARY ===');
  console.log('Total videos:', videos.length);
  console.log('MIME types:', Object.keys(mimeGroups).length);
  for (const [mime, vids] of Object.entries(mimeGroups)) {
    console.log(`${mime}: ${vids.length} (${((vids.length / videos.length) * 100).toFixed(1)}%)`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());