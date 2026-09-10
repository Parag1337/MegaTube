import { prisma } from '../lib/db';

async function main() {
  // Get the first video and test its structure
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

  console.log('Testing MP4 structure for:', video);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  // Get the first 4KB of the file to analyze structure
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
        'Range': 'bytes=0-4095',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 206) {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      console.log(`\nFirst 100 bytes (hex):`);
      for (let i = 0; i < Math.min(100, bytes.length); i += 16) {
        const chunk = bytes.slice(i, i + 16);
        const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(chunk).map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
        console.log(`${i.toString().padStart(4, '0')}: ${hex.padEnd(47)} ${ascii}`);
      }

      // Check for MP4 signature
      if (bytes.length >= 12) {
        const size = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        const type = String.fromCharCode(...bytes.slice(4, 8));
        console.log(`\nBox at offset 0: size=${size}, type='${type}'`);

        if (type === 'ftyp') {
          console.log('Valid MP4 ftyp box found');
          const majorBrand = String.fromCharCode(...bytes.slice(8, 12));
          console.log(`Major brand: ${majorBrand}`);
        } else {
          console.log('NOT a valid MP4 ftyp box');
        }
      }
    } else {
      console.log(`Unexpected status: ${response.status}`);
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