import { prisma } from '../lib/db';

async function main() {
  // Test all videos to see if any fail
  const videos = await prisma.video.findMany({
    where: { megaAccountId: { not: null } },
    select: {
      id: true,
      title: true,
      fileSize: true,
      mimeType: true,
      slug: true,
    },
  });

  console.log(`Testing ${videos.length} videos...`);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  const results = [];

  for (const video of videos) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);

      const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
          'Range': 'bytes=0-1023',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const success = response.status === 206;
      const contentType = response.headers.get('content-type');

      results.push({
        id: video.id,
        title: video.title,
        mimeType: video.mimeType,
        status: response.status,
        success,
        contentType,
      });

      console.log(`Video ${video.id}: ${response.status} - ${success ? 'OK' : 'FAIL'}`);
    } catch (error) {
      results.push({
        id: video.id,
        title: video.title,
        mimeType: video.mimeType,
        status: 'ERROR',
        success: false,
        contentType: null,
      });
      console.log(`Video ${video.id}: ERROR - ${error}`);
    }
  }

  console.log('\n=== SUMMARY ===');
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);

  console.log(`Total: ${results.length}`);
  console.log(`Successful: ${successful.length}`);
  console.log(`Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('\nFailed videos:');
    console.table(failed);
  }

  if (successful.length > 0) {
    console.log('\nSuccessful videos:');
    console.table(successful);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());