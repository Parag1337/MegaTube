import { chromium } from 'playwright';
import { prisma } from '../lib/db';

async function main() {
  // Get a few videos to test
  const videos = await prisma.video.findMany({
    where: { megaAccountId: { not: null } },
    select: {
      id: true,
      title: true,
      slug: true,
      mimeType: true,
    },
    take: 3,
  });

  console.log('Testing video pages with Playwright...');
  console.table(videos);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // First, login to get auth
  const loginPage = await context.newPage();
  await loginPage.goto('http://localhost:3000/login');

  // Fill in login form
  await loginPage.fill('input[type="email"]', 'test@example.com');
  await loginPage.fill('input[type="password"]', 'testpassword123');
  await loginPage.click('button[type="submit"]');

  // Wait for redirect to home
  await loginPage.waitForURL('http://localhost:3000', { timeout: 10000 });
  await loginPage.close();

  // Now test each video page
  for (const video of videos) {
    const page = await context.newPage();
    const videoUrl = `http://localhost:3000/video/${video.slug}`;

    console.log(`\nTesting video ${video.id}: ${video.title}`);
    console.log(`URL: ${videoUrl}`);

    try {
      await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Wait for video element
      const videoElement = await page.waitForSelector('video', { timeout: 10000 });

      if (videoElement) {
        // Get video properties immediately
        const videoInfo = await page.evaluate((video) => {
          return {
            currentSrc: video.currentSrc,
            readyState: video.readyState,
            networkState: video.networkState,
            error: video.error ? {
              code: video.error.code,
              message: video.error.message
            } : null,
            duration: video.duration,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          };
        }, videoElement);

        console.log('Initial video info:', videoInfo);

        // Wait for metadata to load
        await page.waitForTimeout(5000);

        // Check again after waiting
        const videoInfoAfter = await page.evaluate((video) => {
          return {
            readyState: video.readyState,
            networkState: video.networkState,
            error: video.error ? {
              code: video.error.code,
              message: video.error.message
            } : null,
            duration: video.duration,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
          };
        }, videoElement);

        console.log('Video info after 5s:', videoInfoAfter);

        // Try to play
        await page.evaluate((video) => {
          video.play().catch(err => console.log('Play error:', err.message));
        }, videoElement);

        await page.waitForTimeout(3000);

        // Check playing state
        const playingInfo = await page.evaluate((video) => {
          return {
            paused: video.paused,
            currentTime: video.currentTime,
            readyState: video.readyState,
            error: video.error ? {
              code: video.error.code,
              message: video.error.message
            } : null,
          };
        }, videoElement);

        console.log('Playing info:', playingInfo);
      } else {
        console.log('No video element found on page');
      }
    } catch (error) {
      console.log(`Error testing video ${video.id}:`, error);
    } finally {
      await page.close();
    }
  }

  await browser.close();
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());