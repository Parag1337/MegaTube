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
    take: 6,
  });

  console.log('Test videos:');
  console.table(videos);

  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  // Test the API directly with authentication
  for (const video of videos) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      console.log(`Video ${video.id} (${video.title}): ${response.status} ${response.statusText}`);
      const contentType = response.headers.get('content-type');
      console.log(`  Content-Type: ${contentType}`);
      const contentLength = response.headers.get('content-length');
      console.log(`  Content-Length: ${contentLength}`);
      const acceptRanges = response.headers.get('accept-ranges');
      console.log(`  Accept-Ranges: ${acceptRanges}`);
      if (response.status === 200 || response.status === 206) {
        // Only read first 1KB for testing to avoid downloading large files
        const reader = response.body?.getReader();
        if (reader) {
          try {
            const result = await Promise.race([
              reader.read(),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Read timeout')), 5000))
            ]);
            if (result.value && !result.done) {
              const bytes = new Uint8Array(result.value.slice(0, 12));
              console.log(`  First bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
              console.log(`  Read ${result.value.length} bytes (truncated for testing)`);
            }
          } catch (readError) {
            console.log(`  Read error: ${readError}`);
          } finally {
            reader.cancel();
          }
        }
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