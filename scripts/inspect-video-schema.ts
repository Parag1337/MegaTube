import Database from 'better-sqlite3';
const db = new Database('data/database/app.db');
console.log('Video columns:');
for (const row of db.prepare(`SELECT name, type, notnull, dflt_value FROM pragma_table_info('Video') ORDER BY cid`)) {
  console.log(row.name, row.type, row.notnull, row.dflt_value);
}
db.close();
