import { prisma } from '../lib/db';

async function main() {
  // Get some videos to test
  const videos = await prisma.video.findMany({
    where: { megaAccountId: { not: null } },
    select: {
      id: true,
      title: true,
      megaFilename: true,
      fileSize: true,
      mimeType: true,
      slug: true,
    },
    take: 3,
  });

  console.log('Test videos:');
  console.table(videos);

  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  // Test the API with non-aligned Range requests
  for (const video of videos) {
    try {
      // Test with a non-aligned range request (starts at byte 100, not 16-byte aligned)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
          'Range': 'bytes=100-1123',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      console.log(`Video ${video.id} (${video.title}): ${response.status} ${response.statusText}`);
      const contentType = response.headers.get('content-type');
      console.log(`  Content-Type: ${contentType}`);
      const contentRange = response.headers.get('content-range');
      console.log(`  Content-Range: ${contentRange}`);
      const contentLength = response.headers.get('content-length');
      console.log(`  Content-Length: ${contentLength}`);

      if (response.status === 206) {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer.slice(0, 12));
        console.log(`  First bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        console.log(`  Body size: ${buffer.length} bytes (expected 1024)`);
      } else {
        const text = await response.text();
        console.log(`  Response: ${text}`);
      }
    } catch (error) {
      console.log(`Video ${video.id}: Error - ${error}`);
    }
    console.log('---');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());