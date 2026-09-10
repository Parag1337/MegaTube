import Database from 'better-sqlite3';

const db = new Database('data/database/app.db', { readonly: true });
try {
  console.log('video count:', db.prepare('SELECT COUNT(*) AS c FROM Video').get().c);
  console.log('creator count:', db.prepare('SELECT COUNT(*) AS c FROM Creator').get().c);
  console.log('mega account count:', db.prepare('SELECT COUNT(*) AS c FROM MegaAccount').get().c);
  console.log('user count:', db.prepare('SELECT COUNT(*) AS c FROM "User"').get().c);
  console.log('creatorAssignment column exists:', !db.prepare("SELECT 1 FROM pragma_table_info('Video') WHERE name='creatorAssignment'").get());
  console.log('first 5 videos:');
  const videos = db.prepare('SELECT id, title, creatorId, megaAccountId, megaFilename FROM Video ORDER BY id LIMIT 5').all();
  console.log(JSON.stringify(videos, null, 2));
} finally {
  db.close();
}
