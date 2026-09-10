import Database from 'better-sqlite3';
const db = new Database('data/database/app.db');
const rows = db.prepare("SELECT name, type, notnull, dflt_value FROM pragma_table_info('Video') ORDER BY cid").all();
rows.forEach(r => console.log(r.name, r.type, r.notnull, r.dflt_value));
db.close();
