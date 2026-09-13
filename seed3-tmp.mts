import { prisma } from './lib/db';
const stamp = Date.now().toString(36);
for (let i = 0; i < 3; i++) {
  await prisma.video.create({
    data: { megaAccountId: null, megaFilename: `s${i}.mp4`, title: `Sprobe ${stamp} ${i}`, slug: `sprobe-${stamp}-${i}`, creatorAssignment: 'none', fileSize: BigInt(1), mimeType: 'video/mp4' },
  });
}
console.log('seeded', stamp);
await prisma.$disconnect();
