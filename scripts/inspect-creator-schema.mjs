import Database from 'better-sqlite3';
const db = new Database('data/database/app.db', { readonly: true });
console.log('Creator columns:', db.prepare("SELECT name FROM pragma_table_info('Creator')").all().map(r => r.name));
console.log('Video columns:', db.prepare("SELECT name FROM pragma_table_info('Video')").all().map(r => r.name));
db.close();
