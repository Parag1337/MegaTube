import { prisma } from '../lib/db';

async function main() {
  // Test video 31 specifically
  const video = await prisma.video.findUnique({
    where: { id: 31 },
    select: {
      id: true,
      title: true,
      megaFilename: true,
      fileSize: true,
      mimeType: true,
      slug: true,
      megaAccountId: true,
      megaNodeId: true,
    },
  });

  if (!video) {
    console.log('Video 31 not found');
    return;
  }

  console.log('Testing video 31:', video);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  // Test without Range header first
  console.log('\n=== TEST 1: No Range header ===');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log(`Status: ${response.status} ${response.statusText}`);
    const contentType = response.headers.get('content-type');
    console.log(`Content-Type: ${contentType}`);
    const contentLength = response.headers.get('content-length');
    console.log(`Content-Length: ${contentLength}`);

    if (response.status === 200) {
      const reader = response.body?.getReader();
      if (reader) {
        try {
          const result = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Read timeout')), 5000))
          ]);
          if (result.value) {
            const bytes = new Uint8Array(result.value.slice(0, 12));
            console.log(`First bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
            console.log(`Read ${result.value.length} bytes`);
          }
        } catch (readError) {
          console.log(`Read error: ${readError}`);
        } finally {
          reader.cancel();
        }
      }
    } else {
      const text = await response.text();
      console.log(`Response: ${text}`);
    }
  } catch (error) {
    console.log(`Error: ${error}`);
  }

  // Test with Range header
  console.log('\n=== TEST 2: With Range header (bytes=0-1023) ===');
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

    console.log(`Status: ${response.status} ${response.statusText}`);
    const contentRange = response.headers.get('content-range');
    console.log(`Content-Range: ${contentRange}`);

    if (response.status === 206) {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer.slice(0, 12));
      console.log(`First bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      console.log(`Body size: ${buffer.length} bytes`);
    } else {
      const text = await response.text();
      console.log(`Response: ${text}`);
    }
  } catch (error) {
    console.log(`Error: ${error}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());