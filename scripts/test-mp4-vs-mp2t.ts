import { prisma } from '../lib/db';

async function main() {
  // Test one MP4 and one MP2T video
  const mp4Video = await prisma.video.findFirst({
    where: { megaAccountId: { not: null }, mimeType: 'video/mp4' },
    select: {
      id: true,
      title: true,
      mimeType: true,
      fileSize: true,
    },
  });

  const mp2tVideo = await prisma.video.findFirst({
    where: { megaAccountId: { not: null }, mimeType: 'video/mp2t' },
    select: {
      id: true,
      title: true,
      mimeType: true,
      fileSize: true,
    },
  });

  console.log('Testing MP4 vs MP2T videos');
  console.log('MP4 video:', mp4Video);
  console.log('MP2T video:', mp2tVideo);

  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  for (const [type, video] of [['MP4', mp4Video], ['MP2T', mp2tVideo]]) {
    if (!video) continue;

    console.log(`\n=== TESTING ${type} VIDEO (${video.id}) ===`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
          'Range': 'bytes=0-1023',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      console.log(`Status: ${response.status} ${response.statusText}`);
      const contentType = response.headers.get('content-type');
      console.log(`Content-Type: ${contentType}`);

      if (response.status === 206) {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer.slice(0, 12));
        console.log(`First bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        // Check for valid signatures
        if (bytes.length >= 4) {
          // MP4 ftyp signature
          if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
            console.log('Valid MP4 ftyp signature');
          }
          // MPEG-TS signature (0x47 at offset 0, and repeated every 188 bytes)
          if (bytes[0] === 0x47) {
            console.log('MPEG-TS signature detected (0x47 at start)');
          }
        }
      }
    } catch (error) {
      console.log(`Error: ${error}`);
    }
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());