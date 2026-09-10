import { prisma } from '../lib/db';

async function main() {
  // Test video page rendering
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
    const response = await fetch(`http://localhost:3000/video/${video.slug}`, {
      headers: {
        'Cookie': `session_token=${sessionToken}`,
      },
    });

    console.log(`Page status: ${response.status} ${response.statusText}`);
    const html = await response.text();

    // Check if the page contains the video element
    const hasVideoElement = html.includes('<video');
    const hasPrivatePlayer = html.includes('PrivatePlayer');
    const hasApiMediaUrl = html.includes(`/api/media/${video.id}`);

    console.log(`Has video element: ${hasVideoElement}`);
    console.log(`Has PrivatePlayer: ${hasPrivatePlayer}`);
    console.log(`Has API media URL: ${hasApiMediaUrl}`);

    // Extract the video src
    const srcMatch = html.match(/src="([^"]*api\/media\/[^"]*)"/);
    if (srcMatch) {
      console.log(`Video src: ${srcMatch[1]}`);
    }

  } catch (error) {
    console.log(`Error: ${error}`);
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());