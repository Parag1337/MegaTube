import { prisma } from './lib/db';
import { getVideoBySlug } from './lib/videos';
import { getSameCreatorVideos, getTitleRelatedVideos } from './lib/recommendations';
import { listRandomVideos } from './lib/videos';
import Database from 'better-sqlite3';

// Wrap the adapter's database constructor by intercepting the
// @prisma/adapter-better-sqlite3 module.
const Module = await import('module');
const origLoad = Module._load.bind(Module);
let n = 0;
(Module as any)._load = function(req: string, parent: any, isMain: boolean) {
  const m = origLoad(req, parent, isMain);
  if (req === '@prisma/adapter-better-sqlite3') {
    const RealAdapter = (m as any).PrismaBetterSqlite3;
    if (RealAdapter) {
      return Object.assign(m, {
        PrismaBetterSqlite3: class extends RealAdapter {
          constructor(opts: any) {
            super(opts);
            const db = (this as any).database;
            if (db && db.prepare) {
              const orig = db.prepare.bind(db);
              db.prepare = (sql: string) => { n++; return orig(sql); };
            }
          }
        },
      });
    }
  }
  return m;
};
