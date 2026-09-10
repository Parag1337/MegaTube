import { prisma } from '../lib/db';

async function migrateCreatorsToUserScoped() {
  console.log('Starting migration to user-scoped creators...');
  
  // 1. First, we need to temporarily make userId nullable in the schema to allow the migration
  // But since we can't modify the schema during the migration, we'll use a different approach
  
  // 2. Get all existing creators
  const existingCreators = await prisma.creator.findMany();
  console.log(`Found ${existingCreators.length} existing creators to migrate`);
  
  // 3. For each creator, we need to assign them to users
  // Since creators are global now, we'll need to look at which users have videos with these creators
  for (const creator of existingCreators) {
    // Find videos with this creator
    const videos = await prisma.video.findMany({
      where: { creatorId: creator.id },
      include: { megaAccount: true }
    });
    
    console.log(`Creator "${creator.name}" has ${videos.length} videos`);
    
    // Group videos by user
    const userGroups = new Map<string, typeof videos>();
    for (const video of videos) {
      if (video.megaAccount) {
        const userId = video.megaAccount.userId;
        if (!userGroups.has(userId)) {
          userGroups.set(userId, []);
        }
        userGroups.get(userId)!.push(video);
      }
    }
    
    console.log(`  - Videos are owned by ${userGroups.size} different users`);
    
    // For each user that has videos with this creator, create a user-scoped creator
    for (const [userId, userVideos] of userGroups) {
      console.log(`  - Creating user-scoped creator for user ${userId}`);
      
      try {
        // Create a new user-scoped creator
        const newCreator = await prisma.creator.create({
          data: {
            userId,
            name: creator.name,
            slug: `${creator.slug}-${userId.slice(0, 8)}`, // Make slug unique per user
            avatar: creator.avatar,
            description: creator.description,
          }
        });
        
        // Update videos to use the new creator
        await prisma.video.updateMany({
          where: {
            id: { in: userVideos.map(v => v.id) }
          },
          data: {
            creatorId: newCreator.id
          }
        });
        
        console.log(`    - Created creator ID ${newCreator.id} and updated ${userVideos.length} videos`);
      } catch (error) {
        console.error(`    - Error creating creator for user ${userId}:`, error);
      }
    }
  }
  
  // 4. Now delete the old global creators
  console.log('Deleting old global creators...');
  // Since we can't use userId: null (it's not nullable), we'll delete by ID
  for (const creator of existingCreators) {
    try {
      await prisma.creator.delete({
        where: { id: creator.id }
      });
      console.log(`  - Deleted old creator "${creator.name}"`);
    } catch (error) {
      console.error(`  - Error deleting creator "${creator.name}":`, error);
    }
  }
  
  console.log('Migration completed!');
  await prisma.$disconnect();
}

migrateCreatorsToUserScoped().catch(console.error);
