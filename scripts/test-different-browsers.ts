import { prisma } from '../lib/db';

async function main() {
  // Test with different user agents to simulate different browsers
  const video = await prisma.video.findFirst({
    where: { megaAccountId: { not: null } },
    select: {
      id: true,
      title: true,
      mimeType: true,
    },
  });

  if (!video) {
    console.log('No video found');
    return;
  }

  console.log('Testing with different user agents for video:', video);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  for (const ua of userAgents) {
    console.log(`\n=== Testing with: ${ua.substring(0, 50)}... ===`);

    try {
      const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
          'Range': 'bytes=0-1023',
          'User-Agent': ua,
        },
      });

      console.log(`Status: ${response.status} ${response.statusText}`);
      const contentType = response.headers.get('content-type');
      console.log(`Content-Type: ${contentType}`);

      if (response.status === 206) {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer.slice(0, 12));
        console.log(`First bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      }
    } catch (error) {
      console.log(`Error: ${error}`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());