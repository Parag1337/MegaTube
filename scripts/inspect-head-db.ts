import Database from 'better-sqlite3';

const d = new Database('/tmp/app_head.db');
const tables = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
for (const t of tables) {
  console.log(`\n=== table ${t.name} ===`);
  console.log(t.sql || '(no sql)');
}
console.log('\n=== video count ===');
console.log(d.prepare('SELECT COUNT(*) AS c FROM Video').get());
console.log('\n=== creator count ===');
console.log(d.prepare('SELECT COUNT(*) AS c FROM Creator').get());
console.log('\n=== mega account count ===');
console.log(d.prepare('SELECT COUNT(*) AS c FROM MegaAccount').get());
console.log('\n=== user count ===');
console.log(d.prepare('SELECT COUNT(*) AS c FROM User').get());
console.log('\n=== video creatorAssignment column ===');
const col = d.prepare("SELECT name FROM pragma_table_info('Video') WHERE name='creatorAssignment'").get();
console.log('creatorAssignment exists in HEAD db:', !!col);
console.log('\n=== sample videos (first 5) ===');
const sample = d.prepare('SELECT id, title, slug, creatorId, megaAccountId, megaFilename FROM Video ORDER BY id LIMIT 5').all();
for (const r of sample) console.log(JSON.stringify(r));
console.log('\n=== sample creators (first 5) ===');
const csample = d.prepare('SELECT id, userId, name, slug FROM Creator ORDER BY id LIMIT 5').all();
for (const r of csample) console.log(JSON.stringify(r));
d.close();
