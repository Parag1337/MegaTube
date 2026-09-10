import Database from 'better-sqlite3';
const db = new Database('data/database/app.db');
console.log('Video columns:');
const stmt = db.prepare(`SELECT name, type, notnull, dflt_value FROM pragma_table_info('Video') ORDER BY cid`);
const rows = stmt.all();
for (const row of rows) {
  console.log(row.name, row.type, row.notnull, row.dflt_value);
}
db.close();
