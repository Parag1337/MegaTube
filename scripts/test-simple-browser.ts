import { prisma } from '../lib/db';

async function main() {
  // Simple test to check if the video page loads correctly
  const video = await prisma.video.findFirst({
    where: { megaAccountId: { not: null } },
    select: {
      id: true,
      title: true,
      slug: true,
      mimeType: true,
    },
  });

  if (!video) {
    console.log('No video found');
    return;
  }

  console.log('Testing video page:', video);
  const sessionToken = 'M0JK1Rup7XQpD9xwMGO8kijmqrOXL-0flN8F9_r9uZ0';

  try {
    // Test the video page
    const pageResponse = await fetch(`http://localhost:3000/video/${video.slug}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
      },
    });

    console.log(`Page status: ${pageResponse.status} ${pageResponse.statusText}`);

    if (pageResponse.status === 200) {
      const html = await pageResponse.text();

      // Check for potential issues
      const hasVideoElement = html.includes('<video');
      const hasPrivatePlayer = html.includes('PrivatePlayer');
      const hasApiMediaUrl = html.includes(`/api/media/${video.id}`);
      const hasCorrectMimeType = html.includes(video.mimeType);

      console.log(`Has video element: ${hasVideoElement}`);
      console.log(`Has PrivatePlayer: ${hasPrivatePlayer}`);
      console.log(`Has API media URL: ${hasApiMediaUrl}`);
      console.log(`Has correct MIME type in page: ${hasCorrectMimeType}`);

      // Extract video src
      const srcMatch = html.match(/src="([^"]*api\/media\/[^"]*)"/);
      if (srcMatch) {
        console.log(`Video src: ${srcMatch[1]}`);

        // Test the media URL directly
        console.log('\n=== Testing media URL directly ===');
        const mediaResponse = await fetch(`http://localhost:3000${srcMatch[1]}`, {
          headers: {
            'Cookie': `session_token=${sessionToken}`,
            'Range': 'bytes=0-1023',
          },
        });

        console.log(`Media status: ${mediaResponse.status} ${mediaResponse.statusText}`);
        const contentType = mediaResponse.headers.get('content-type');
        console.log(`Media Content-Type: ${contentType}`);

        if (mediaResponse.status === 206) {
          const buffer = await mediaResponse.arrayBuffer();
          const bytes = new Uint8Array(buffer.slice(0, 12));
          console.log(`Media first bytes: ${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
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