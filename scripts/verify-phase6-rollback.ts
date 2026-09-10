import Database from 'better-sqlite3';
import { PrismaClient } from '@prisma/client';

const sql = new Database('data/database/app.db');
const prisma = new PrismaClient({
  datasources: { db: { url: 'file:./data/database/app.db' } },
});

async function main() {
try {
  console.log('=== video count ===');
  console.log(await prisma.video.count());
  console.log('=== creator count ===');
  console.log(await prisma.creator.count());
  console.log('=== mega account count ===');
  console.log(await prisma.megaAccount.count());
  console.log('=== user count ===');
  console.log(await prisma.user.count());
  console.log('=== creatorAssignment column exists ===');
  const hasCol = sql.prepare("SELECT 1 FROM pragma_table_info('Video') WHERE name='creatorAssignment'").get();
  console.log(Boolean(hasCol));
  console.log('=== sample videos (first 3) ===');
  const sample = await prisma.video.findMany({ take: 3, orderBy: { id: 'asc' }, select: { id: true, title: true, slug: true, creatorId: true, megaAccountId: true, megaFilename: true } });
  for (const r of sample) console.log(JSON.stringify(r));
  console.log('=== sample creators (first 3) ===');
  const csample = await prisma.creator.findMany({ take: 3, orderBy: { id: 'asc' }, select: { id: true, name: true, slug: true } });
  for (const r of csample) console.log(JSON.stringify(r));
  console.log('=== thumbnail files count ===');
  console.log(sql.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get());
} finally {
  await prisma.$disconnect();
  sql.close();
}
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
