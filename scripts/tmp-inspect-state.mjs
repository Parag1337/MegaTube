import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DB = 'data/database/app.db';
const db = new Database(DB, { readonly: true });

function q(sql, ...args) {
  return db.prepare(sql).all(...args);
}

const videoCount = q('SELECT COUNT(*) AS n FROM Video')[0].n;
console.log('Video count:', videoCount);
console.log('MegaAccount count:', q('SELECT COUNT(*) AS n FROM MegaAccount')[0].n);
console.log('User count:', q('SELECT COUNT(*) AS n FROM User')[0].n);

console.log('\nBy mime type:', JSON.stringify(q('SELECT mimeType, COUNT(*) AS n FROM Video GROUP BY mimeType')));
console.log('Null duration:', q('SELECT COUNT(*) AS n FROM Video WHERE duration IS NULL')[0].n);
console.log('Duration distribution:', JSON.stringify(q(
  'SELECT CASE WHEN duration IS NULL THEN \'null\' WHEN duration < 600 THEN \'<10min\' WHEN duration < 3600 THEN \'10-60min\' ELSE \'>1h\' END AS bucket, COUNT(*) AS n FROM Video GROUP BY bucket'
)));

console.log('\nLargest videos (candidates for long/problematic):');
for (const r of q('SELECT id, slug, fileSize, duration, mimeType FROM Video WHERE megaAccountId IS NOT NULL ORDER BY fileSize DESC LIMIT 12')) {
  console.log(' ', JSON.stringify(r));
}

console.log('\nSample of MPEG-TS videos:');
for (const r of q("SELECT id, slug, fileSize, duration, mimeType FROM Video WHERE mimeType LIKE '%mp2t%' ORDER BY fileSize DESC LIMIT 8")) {
  console.log(' ', JSON.stringify(r));
}

// Cache dir: read from env / defaults the same way the app does
console.log('\nCache dir candidates:');
for (const dir of ['data/media-cache', 'data/cache', '.media-cache', 'media-cache', 'data/database/media-cache']) {
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
    const total = files.reduce((acc, f) => acc + statSync(join(dir, f)).size, 0);
    console.log(`  ${dir}: ${files.length} files, ${(total / 1048576).toFixed(0)} MB`);
    console.log('    sample:', files.slice(0, 12).join(', '));
  } else {
    console.log(`  ${dir}: (absent)`);
  }
}

db.close();
