import { prisma } from '../lib/db';

async function main() {
  // Test aligned vs non-aligned ranges to see if decryption is correct
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

  console.log('Testing aligned vs non-aligned decryption for:', video);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  // Test aligned range (96-111 is 16-byte aligned: 96 % 16 == 0)
  const alignedRange = 'bytes=96-111';
  // Test non-aligned range (100-115 is not 16-byte aligned)
  const nonAlignedRange = 'bytes=100-115';

  console.log('\n=== ALIGNED RANGE (96-111) ===');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
        'Range': alignedRange,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 206) {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      console.log(`Bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  } catch (error) {
    console.log(`Error: ${error}`);
  }

  console.log('\n=== NON-ALIGNED RANGE (100-115) ===');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
        'Range': nonAlignedRange,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 206) {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      console.log(`Bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  } catch (error) {
    console.log(`Error: ${error}`);
  }

  console.log('\n=== FULL FILE BYTES 96-115 (for comparison) ===');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
        'Range': 'bytes=0-127',
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status === 206) {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      console.log(`Bytes 96-111: ${Array.from(bytes.slice(96, 112)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      console.log(`Bytes 100-115: ${Array.from(bytes.slice(100, 116)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
    }
  } catch (error) {
    console.log(`Error: ${error}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());