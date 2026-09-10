import { prisma } from '../lib/db';

async function main() {
  // Test if the offset calculation is correct
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

  console.log('Testing range offset calculation for:', video);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  // Test range starting at 100 (not 16-byte aligned)
  // The server should:
  // 1. Calculate apiStart = 100 - (100 % 16) = 96
  // 2. Request bytes 96-end from MEGA
  // 3. Skip first 4 bytes (100 - 96 = 4)
  // 4. Return bytes 100-end

  const testRange = 'bytes=100-200';

  console.log(`\nTesting range: ${testRange}`);
  console.log('Expected behavior:');
  console.log('  - apiStart = 100 - (100 % 16) = 96');
  console.log('  - skipBytes = 100 - 96 = 4');
  console.log('  - Request MEGA range: 96-200');
  console.log('  - Skip first 4 bytes of decrypted data');
  console.log('  - Return bytes 100-200');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
        'Range': testRange,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    console.log(`\nResponse: ${response.status} ${response.statusText}`);
    const contentRange = response.headers.get('content-range');
    console.log(`Content-Range: ${contentRange}`);

    if (response.status === 206) {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      console.log(`Body size: ${buffer.length} bytes (expected 101)`);
      console.log(`First 20 bytes: ${Array.from(bytes.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

      // Compare with the full file
      console.log('\n=== COMPARISON WITH FULL FILE ===');
      const fullResponse = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
          'Range': 'bytes=0-300',
        },
      });

      if (fullResponse.status === 206) {
        const fullBuffer = await fullResponse.arrayBuffer();
        const fullBytes = new Uint8Array(fullBuffer);
        const expectedBytes = fullBytes.slice(100, 201);
        console.log(`Expected bytes 100-200: ${Array.from(expectedBytes.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        const match = bytes.length === expectedBytes.length &&
          Array.from(bytes).every((b, i) => b === expectedBytes[i]);
        console.log(`Bytes match: ${match}`);

        if (!match) {
          console.log('\n=== MISMATCH DETAILS ===');
          for (let i = 0; i < Math.min(bytes.length, expectedBytes.length); i++) {
            if (bytes[i] !== expectedBytes[i]) {
              console.log(`Offset ${i}: got ${bytes[i].toString(16).padStart(2, '0')}, expected ${expectedBytes[i].toString(16).padStart(2, '0')}`);
            }
          }
        }
      }
    }
  } catch (error) {
    console.log(`Error: ${error}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());