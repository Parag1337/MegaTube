import { prisma } from '../lib/db';

async function main() {
  // Test one video with various range requests
  const video = await prisma.video.findFirst({
    where: { megaAccountId: { not: null } },
    select: {
      id: true,
      title: true,
      fileSize: true,
      mimeType: true,
    },
  });

  if (!video) {
    console.log('No video found');
    return;
  }

  console.log('Testing video:', video);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  const testRanges = [
    'bytes=0-1023',       // Aligned start
    'bytes=16-1039',     // Aligned start (16-byte boundary)
    'bytes=100-1123',    // Non-aligned start
    'bytes=32-1055',     // Aligned start (32-byte boundary)
    'bytes=50-1073',    // Non-aligned start
  ];

  for (const range of testRanges) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
          'Range': range,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      console.log(`\nRange: ${range}`);
      console.log(`Status: ${response.status} ${response.statusText}`);
      const contentRange = response.headers.get('content-range');
      console.log(`Content-Range: ${contentRange}`);

      if (response.status === 206) {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer.slice(0, 16));
        console.log(`First 16 bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
        console.log(`Body size: ${buffer.length} bytes`);
      } else {
        const text = await response.text();
        console.log(`Response: ${text}`);
      }
    } catch (error) {
      console.log(`Error: ${error}`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());