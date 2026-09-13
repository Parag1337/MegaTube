import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
// Patch the constructor via the module's exports reference
const orig = Database;
let n = 0; const sqls: string[] = [];
const patched = function(this: any, ...args: any[]) {
  const db = new (orig as any)(...args);
  const o = db.prepare;
  db.prepare = (sql: string) => { n++; if (sqls.length < 40) sqls.push(sql.split('\n')[0].slice(0,70)); return o.call(db, sql); };
  return db;
};
patched.prototype = orig.prototype;
Object.setPrototypeOf(patched, orig);
// Replace the export in the require cache
const mod = require('@prisma/adapter-better-sqlite3');
const RealAdapter = mod.PrismaBetterSqlite3;
mod.PrismaBetterSqlite3 = class extends RealAdapter {
  constructor(opts: any) { super(opts); const db = (this as any).database; if (db && db.prepare) { const o = db.prepare.bind(db); db.prepare = (s: string) => { n++; if (sqls.length < 40) sqls.push(s.split('\n')[0].slice(0,70)); return o(s); } } }
};
// force re-eval of db.ts by clearing prisma from cache
const dbMod = require('./lib/db.ts');
