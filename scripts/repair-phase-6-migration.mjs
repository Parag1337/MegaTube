import Database from 'better-sqlite3';

const db = new Database('data/database/app.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

try {
  console.log('pre-check: Creator.userId empty count');
  console.log(db.prepare("SELECT COUNT(*) AS c FROM Creator WHERE userId='' OR userId IS NULL").get().c);

  console.log('pre-check: Video.creatorAssignment distribution');
  console.log(db.prepare("SELECT creatorAssignment, COUNT(*) AS c FROM Video GROUP BY creatorAssignment").all());

  // Remove the Phase 6 column and indexes first, then fix Creator.userId.
  console.log('dropping Video.creatorAssignment...');
  db.exec(`ALTER TABLE Video DROP COLUMN creatorAssignment`);
  console.log('Video.creatorAssignment dropped:', !db.prepare("SELECT 1 FROM pragma_table_info('Video') WHERE name='creatorAssignment'").get());

  console.log('Creator user assignment via video->account chain...');
  const accountMap = db.prepare('SELECT id, userId FROM MegaAccount').all();
  const accountUserId = new Map(accountMap.map((a) => [a.id, a.userId]));
  const rows = db.prepare('SELECT id, creatorId, megaAccountId FROM Video WHERE creatorId IS NOT NULL ORDER BY id').all();
  const creatorOwners = new Map();
  for (const r of rows) {
    const oid = accountUserId.get(r.megaAccountId);
    if (!oid) continue;
    const cur = creatorOwners.get(r.creatorId);
    if (cur === undefined) creatorOwners.set(r.creatorId, oid);
    else if (cur !== oid) creatorOwners.set(r.creatorId, null);
  }

  const ambiguous = [...creatorOwners.entries()].filter(([, v]) => v === null);
  console.log('creators with a single owner:', creatorOwners.size - ambiguous.length);
  console.log('ambiguous creators (multiple users):', ambiguous.length);
  for (const [cid, _] of ambiguous) console.log('ambiguous creator id:', cid);

  console.log('updating Creator.userId...');
  const update = db.prepare('UPDATE Creator SET userId = ? WHERE id = ?');
  const successful = [];
  for (const [cid, uid] of creatorOwners.entries()) {
    if (!uid) {
      console.log('skipping ambiguous creator id=', cid);
      continue;
    }
    update.run(uid, cid);
    successful.push(cid);
  }
  console.log('creators updated:', successful.length);

  console.log('remaining creators with empty userId:', db.prepare("SELECT COUNT(*) AS c FROM Creator WHERE userId='' OR userId IS NULL").get().c);

  console.log('fixing duplicate slugs across users (leave one per slug, mark others as deleted via unused userId?)...');
  // Strategy: keep creators with valid userId; if duplicates remain after assignment (because some creators
  // were ambiguous), we need a safer handling. For now just report duplicates.
  const slugRows = db.prepare('SELECT id, userId, slug FROM Creator').all();
  const bySlug = new Map();
  for (const r of slugRows) {
    const list = bySlug.get(r.slug) ?? [];
    list.push(r);
    bySlug.set(r.slug, list);
  }
  const dupes = [...bySlug.values()].filter((g) => new Set(g.map((x) => x.userId)).size > 1);
  console.log('slugs with multiple users after assignment:', dupes.length);
  for (const group of dupes) {
    console.log('slug=', group[0].slug, 'ids=', group.map((x) => x.id), 'userIds=', group.map((x) => x.userId));
  }

  console.log('post-check: Video.creatorAssignment distribution');
  console.log(db.prepare("SELECT creatorAssignment, COUNT(*) AS c FROM Video GROUP BY creatorAssignment").all());
  console.log('post-check: Creator.userId empty count');
  console.log(db.prepare("SELECT COUNT(*) AS c FROM Creator WHERE userId='' OR userId IS NULL").get().c);

} finally {
  db.close();
}
