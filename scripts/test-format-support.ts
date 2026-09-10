import { prisma } from '../lib/db';

async function main() {
  // Test if MPEG-TS format is the issue
  const mp4Video = await prisma.video.findFirst({
    where: { megaAccountId: { not: null }, mimeType: 'video/mp4' },
    select: {
      id: true,
      title: true,
      mimeType: true,
      slug: true,
    },
  });

  const mp2tVideo = await prisma.video.findFirst({
    where: { megaAccountId: { not: null }, mimeType: 'video/mp2t' },
    select: {
      id: true,
      title: true,
      mimeType: true,
      slug: true,
    },
  });

  console.log('Testing format support hypothesis');
  console.log('MP4 video:', mp4Video);
  console.log('MPEG-TS video:', mp2tVideo);

  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  // Test both formats with detailed analysis
  for (const [format, video] of [['MP4', mp4Video], ['MPEG-TS', mp2tVideo]]) {
    if (!video) continue;

    console.log(`\n=== ${format} FORMAT TEST (${video.id}) ===`);

    // Test API response
    try {
      const response = await fetch(`http://localhost:3000/api/media/${video.id}`, {
        headers: {
          'Cookie': `session_token=${sessionToken}`,
          'Range': 'bytes=0-1023',
        },
      });

      console.log(`API Status: ${response.status} ${response.statusText}`);
      const contentType = response.headers.get('content-type');
      console.log(`Content-Type: ${contentType}`);

      if (response.status === 206) {
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        // Analyze the actual bytes
        console.log(`First 20 bytes: ${Array.from(bytes.slice(0, 20)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);

        // Check format signatures
        if (bytes[0] === 0x00 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
          console.log('Format signature: MP4 (ftyp)');
        } else if (bytes[0] === 0x47) {
          console.log('Format signature: MPEG-TS (0x47 sync byte)');
        } else {
          console.log('Format signature: Unknown');
        }

        // Check if Content-Type matches actual format
        const isMp4Format = bytes[0] === 0x00 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
        const isMp2tFormat = bytes[0] === 0x47;

        const contentTypeMatches = (contentType === 'video/mp4' && isMp4Format) ||
                                   (contentType === 'video/mp2t' && isMp2tFormat);

        console.log(`Content-Type matches actual format: ${contentTypeMatches}`);

        if (!contentTypeMatches) {
          console.log('⚠️  MISMATCH: Content-Type does not match actual format!');
          console.log(`   Content-Type: ${contentType}`);
          console.log(`   Actual format: ${isMp4Format ? 'MP4' : isMp2tFormat ? 'MPEG-TS' : 'Unknown'}`);
        }
      }
    } catch (error) {
      console.log(`Error: ${error}`);
    }
  }

  console.log('\n=== BROWSER COMPATIBILITY ===');
  console.log('MP4 (video/mp4): Widely supported by all modern browsers');
  console.log('MPEG-TS (video/mp2t): Limited browser support');
  console.log('  - Chrome: Partial support (may not work in <video> element)');
  console.log('  - Firefox: Limited support');
  console.log('  - Safari: Limited support');
  console.log('  - Edge: Similar to Chrome');
  console.log('\nThis could explain why some videos fail in browsers!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());