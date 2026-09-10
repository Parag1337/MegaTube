import Database from 'better-sqlite3';
import { PrismaClient } from '../generated/index.js';

const sql = new Database('data/database/app.db');
const prisma = new PrismaClient({
  datasources: { db: { url: 'file:./data/database/app.db' } },
});

async function main() {
  console.log('=== Creator rows (schema + data) ===');
  console.log(sql.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='Creator'`).get());
  const creators = prisma.creator.findMany({
    include: { _count: { select: { videos: true } } },
    orderBy: { id: 'asc' },
  });
  console.log('creator count:', creators.length);
  console.log('--- creator rows ---');
  for (const c of creators) {
    console.log(`creator id=${c.id} userId=[${c.userId}] name=[${c.name}] slug=[${c.slug}] videoCount=${c._count.videos}`);
  }

  console.log('\n=== User rows ===');
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  console.log('user count:', users.length);
  console.log('--- user rows ---');
  for (const u of users) {
    console.log(`user id=[${u.id}] email=[${u.email}]`);
  }

  console.log('\n=== MegaAccount -> User mapping ===');
  const accounts = await prisma.megaAccount.findMany({
    select: { id: true, userId: true, megaEmail: true },
    orderBy: { id: 'asc' },
  });
  console.log('account count:', accounts.length);
  console.log('--- mega accounts ---');
  for (const a of accounts) {
    console.log(`account id=${a.id} userId=[${a.userId}] megaEmail=[${a.megaEmail}]`);
  }

  console.log('\n=== Video creatorAssignment distribution ===');
  const videoCounts = await prisma.video.groupBy({
    by: ['creatorAssignment'],
    _count: { id: true },
    orderBy: { creatorAssignment: 'asc' },
  });
  for (const row of videoCounts) {
    console.log(JSON.stringify({ creatorAssignment: row.creatorAssignment, count: row._count.id }));
  }

  console.log('\n=== Video creatorId distribution ===');
  const withCreator = await prisma.video.count({ where: { creatorId: { not: null } } });
  const withoutCreator = await prisma.video.count({ where: { creatorId: null } });
  console.log('videos with creatorId:', withCreator);
  console.log('videos without creatorId:', withoutCreator);
  const totalVideos = await prisma.video.count();
  console.log('total videos:', totalVideos);

  console.log('\n=== Creator ownership via video -> account -> user chain ===');
  const rows = await prisma.video.findMany({
    where: { creatorId: { not: null } },
    select: { id: true, creatorId: true, megaAccountId: true },
    orderBy: { id: 'asc' },
  });
  const ownerMap = new Map<number, Set<string>>();
  const accountOwnerMap = new Map<number, string>();
  for (const r of rows) {
    const owners = ownerMap.get(r.creatorId) ?? new Set<string>();
    if (r.megaAccountId !== null) {
      const acc = await prisma.megaAccount.findUnique({ where: { id: r.megaAccountId }, select: { userId: true } });
      if (acc?.userId) {
        owners.add(acc.userId);
        accountOwnerMap.set(r.megaAccountId, acc.userId);
      }
    }
    ownerMap.set(r.creatorId, owners);
  }

  const ambiguous = [...ownerMap.entries()].filter(([, owners]) => owners.size > 1);
  console.log('creators with videos:', ownerMap.size);
  console.log('ambiguous creators (videos belong to more than one user):', ambiguous.length);
  for (const [creatorId, owners] of ambiguous) {
    console.log(JSON.stringify({ creatorId, ownerUserIds: [...owners] }));
  }

  console.log('\n=== Sample creator->videos->owner chain ===');
  const sampleCreatorIds = [...ownerMap.keys()].slice(0, 5);
  for (const creatorId of sampleCreatorIds) {
    const sampleVideo = rows.find((r) => r.creatorId === creatorId);
    console.log(JSON.stringify({
      creatorId,
      sampleVideoId: sampleVideo?.id,
      sampleVideoAccountId: sampleVideo?.megaAccountId,
      owners: [...ownerMap.get(creatorId)!],
    }));
  }

  console.log('\n=== Foreign key check: Creator.userId -> User.id ===');
  const invalidCreators = await prisma.creator.findMany({
    where: {
      OR: [
        { userId: null },
        { userId: { equals: '' } },
      ],
    },
    select: { id: true, userId: true, name: true },
  });
  console.log('creators with missing/empty userId (should be 0):', invalidCreators.length);
  for (const c of invalidCreators) {
    console.log(JSON.stringify(c));
  }

  console.log('\n=== Creator uniqueness: duplicate slugs across users ===');
  const slugRows = await prisma.creator.findMany({ select: { id: true, userId: true, slug: true } });
  const slugMap = new Map<string, string[]>();
  for (const row of slugRows) {
    const list = slugMap.get(row.slug) ?? [];
    list.push(row.userId);
    slugMap.set(row.slug, list);
  }
  const dupes = [...slugMap.entries()].filter(([, userIds]) => new Set(userIds).size > 1);
  console.log('duplicate slugs across different users:', dupes.length);
  for (const [slug, userIds] of dupes) {
    console.log(JSON.stringify({ slug, userIds }));
  }

  await prisma.$disconnect();
  sql.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
