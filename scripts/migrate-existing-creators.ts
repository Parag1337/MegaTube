import { prisma } from '../lib/db';

async function migrateExistingCreators() {
  console.log('Starting migration for existing creatorless videos...');
  
  // Get all videos with megaAccountId (private videos) that have creatorId
  const videosWithCreators = await prisma.video.findMany({
    where: {
      megaAccountId: { not: null },
      creatorId: { not: null }
    },
    include: {
      megaAccount: true,
      creator: true
    }
  });
  
  console.log(`Found ${videosWithCreators.length} videos with creators`);
  
  // Group by user
  const userGroups = new Map<string, Array<{video: typeof videosWithCreators[0], creator: typeof videosWithCreators[0]['creator']}>>();
  for (const video of videosWithCreators) {
    if (video.megaAccount && video.creator) {
      const userId = video.megaAccount.userId;
      if (!userGroups.has(userId)) {
        userGroups.set(userId, []);
      }
      const userVideos = userGroups.get(userId);
      if (userVideos) {
        userVideos.push({ video, creator: video.creator });
      }
    }
  }
  
  console.log(`Videos belong to ${userGroups.size} different users`);
  
  // For each user, create user-scoped creators for their videos
  for (const [userId, items] of userGroups) {
    console.log(`Processing user ${userId}...`);
    
    // Group by creator name
    const creatorGroups = new Map<string, Array<typeof videosWithCreators[0]>>();
    for (const { video, creator } of items) {
      if (!creatorGroups.has(creator.name)) {
        creatorGroups.set(creator.name, []);
      }
      const creatorVideos = creatorGroups.get(creator.name);
      if (creatorVideos) {
        creatorVideos.push(video);
      }
    }
    
    console.log(`  User has ${creatorGroups.size} unique creator names`);
    
    // For each unique creator name, create a user-scoped creator
    for (const [creatorName, videos] of creatorGroups) {
      console.log(`  - Creating user-scoped creator "${creatorName}"`);
      
      try {
        // Generate a user-specific slug
        const slug = `${creatorName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${userId.slice(0, 8)}`;
        
        const newCreator = await prisma.creator.create({
          data: {
            userId,
            name: creatorName,
            slug,
          }
        });
        
        // Update videos to use the new creator
        await prisma.video.updateMany({
          where: {
            id: { in: videos.map(v => v.id) }
          },
          data: {
            creatorId: newCreator.id,
            creatorAssignment: 'auto'
          }
        });
        
        console.log(`    - Created creator ID ${newCreator.id} and updated ${videos.length} videos`);
      } catch (error) {
        console.error(`    - Error:`, error);
      }
    }
  }
  
  // For videos without creators but with megaAccountId, set creatorAssignment to 'none'
  const videosWithoutCreators = await prisma.video.updateMany({
    where: {
      megaAccountId: { not: null },
      creatorId: null,
      creatorAssignment: null
    },
    data: {
      creatorAssignment: 'none'
    }
  });
  
  console.log(`Updated ${videosWithoutCreators.count} videos without creators to have creatorAssignment='none'`);
  
  console.log('Migration completed!');
  await prisma.$disconnect();
}

migrateExistingCreators().catch(console.error);
