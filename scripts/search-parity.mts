/**
 * Compile the lib's actual SQL fragments and print/execute them for parity.
 */
import { PrismaPg } from '@prisma/adapter-pg';

const { PrismaClient } = await import('../generated/client');
const { parseSearchQuery, buildSearchFilterSql, buildSearchRankSql } = await import('../lib/search');

const adapter = new PrismaPg({
  connectionString: 'postgresql://megatube:megatube-dev-only@localhost:5433/megatube?schema=public',
});
const prisma = new PrismaClient({ adapter });

const QUERIES = [
  'Alpha',
  'video',
  'Star Creator',
  'underwater',
  'Galaxy Tour',
  'alpha || galaxy',
  'alpha && tour',
  '!alpha',
  'alpha && !galaxy',
  '"Deep Sea"',
  'Al',
  'zzzznope',
  'documentary',
  'clip',
  'alpha && !plank',
  '(alpha || newton) && !plank',
  '100%_%',
  "o'brien",
  'café',
  // Real-library terms (from the actual VideoSearch contents).
  'strapon',
  'pegging',
  'strapon || pegging',
  'strapon && joi',
  'strapon && !joi',
  '"Strap On Deal"',
  'Kristie',
  'Kristie Bish',
  'Watch_Summer',
  'spank',
  'yoga',
  'pov && strapon',
  '!strapon',
  'jerk',
  'sissification',
  'voe',
  'str',
];

// Old SQLite engine (same inline copy as scripts/search-parity.mts).
import Database from 'better-sqlite3';
const sqlite = new Database('data/database/app.db', { readonly: true });

function oldEngine(query, accIds) {
  const tokens = tokenizePublic(query);
  let pos = 0;
  const peek = () => tokens[pos];
  function parseOr() {
    let left = parseAnd();
    for (;;) {
      const t = peek();
      if (!t) return left;
      if (t.kind === 'or') {
        pos++;
        left = or(left, parseAnd());
        continue;
      }
      if (t.kind === 'term' || t.kind === 'not' || t.kind === 'lp') {
        left = or(left, parseAnd());
        continue;
      }
      return left;
    }
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek()?.kind === 'and') {
      pos++;
      left = and(left, parseUnary());
    }
    return left;
  }
  function parseUnary() {
    if (peek()?.kind === 'not') {
      pos++;
      return { kind: 'not', child: parseUnary() };
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('syntax');
    if (t.kind === 'term') {
      pos++;
      return { kind: 'term', value: t.value };
    }
    if (t.kind === 'lp') {
      pos++;
      const inner = parseOr();
      if (peek()?.kind !== 'rp') throw new Error('syntax');
      pos++;
      return inner;
    }
    throw new Error('syntax');
  }
  function or(l, r) {
    return { kind: 'or', children: [...(l.kind === 'or' ? l.children : [l]), ...(r.kind === 'or' ? r.children : [r])] };
  }
  function and(l, r) {
    return { kind: 'and', children: [...(l.kind === 'and' ? l.children : [l]), ...(r.kind === 'and' ? r.children : [r])] };
  }
  const ast = parseOr();

  const eligible = (v) => v.split(/\s+/).every((p) => p.length >= 3);
  const phrase = (v) => `"${v.replace(/"/g, '""')}"`;
  const likePat = (v) => `%${v.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  const E = '\\';

  function filterSql(n) {
    switch (n.kind) {
      case 'term':
        if (eligible(n.value)) {
          return { sql: `EXISTS(SELECT 1 FROM "VideoSearch" AS s WHERE s.rowid = v.id AND s.VideoSearch MATCH ?)`, args: [phrase(n.value)] };
        }
        return {
          sql: `(v.title LIKE ? ESCAPE '${E}' OR v.megaFilename LIKE ? ESCAPE '${E}' OR EXISTS(SELECT 1 FROM "Creator" c WHERE c.id = v.creatorId AND c.name LIKE ? ESCAPE '${E}'))`,
          args: [likePat(n.value), likePat(n.value), likePat(n.value)],
        };
      case 'not': {
        const c = filterSql(n.child);
        return { sql: `(NOT ${c.sql})`, args: c.args };
      }
      case 'and':
      case 'or': {
        let sql = '';
        const args = [];
        n.children.forEach((c, i) => {
          const r = filterSql(c);
          if (i > 0) sql += ` ${n.kind.toUpperCase()} `;
          sql += r.sql;
          args.push(...r.args);
        });
        return { sql: `(${sql})`, args };
      }
    }
  }

  function positive(n, out, seen) {
    if (n.kind === 'term') {
      if (eligible(n.value) && !seen.has(n.value)) {
        seen.add(n.value);
        out.push(n.value);
      }
      return;
    }
    if (n.kind === 'not') return;
    for (const c of n.children) positive(c, out, seen);
  }

  const filter = filterSql(ast);
  const terms = [];
  positive(ast, terms, new Set());
  const rank = terms.length
    ? `(SELECT bm25("VideoSearch", 2.0, 1.0, 1.0) FROM "VideoSearch" AS r WHERE r.rowid = v.id AND r.VideoSearch MATCH ?)`
    : null;
  const orderBy = rank
    ? `CASE WHEN rank IS NULL THEN 1 ELSE 0 END, rank ASC, v.createdAt DESC, v.id DESC`
    : `v.createdAt DESC, v.id DESC`;
  const scopeSql =
    accIds.length > 0
      ? `(v.megaAccountId IS NULL OR v.megaAccountId IN (${accIds.map(() => '?').join(',')}))`
      : `v.megaAccountId IS NULL`;
  const sql = `SELECT v.id${rank ? `, ${rank} AS rank` : ''} FROM "Video" v WHERE ${scopeSql} AND ${filter.sql} ORDER BY ${orderBy}`;
  // Placeholder order follows SQL text: the rank subquery lives in the
  // SELECT list (before WHERE), so its args come FIRST, then scope, then
  // filter.
  const args = rank
    ? [terms.map(phrase).join(' OR '), ...accIds, ...filter.args]
    : [...accIds, ...filter.args];
  if (process.env.PARITY_DEBUG) {
    console.error('DEBUG sql:', sql);
    console.error('DEBUG args:', JSON.stringify(args));
    console.error('DEBUG count:', sqlite.prepare(sql).all(...args).length);
  }
  return sqlite.prepare(sql).all(...args).map((r) => r.id).map(Number);
}

console.log('query'.padEnd(28), 'cnt', 'set', 'order', 'top5');
let allSets = true;
const { Prisma } = await import('../generated/client');

// Real data: the catalog is private. Resolve the first user's non-disconnected
// account scope on each side so both engines see the SAME videos.
const sqFirstUser = sqlite
  .prepare(`SELECT userId FROM MegaAccount WHERE status <> 'DISCONNECTED' ORDER BY id LIMIT 1`)
  .get()?.userId;
const sqAccIds = sqlite
  .prepare(`SELECT id FROM MegaAccount WHERE userId = ? AND status <> 'DISCONNECTED'`)
  .all(sqFirstUser)
  .map((r) => r.id);
const pgScope = await prisma.$queryRaw
  `SELECT id FROM "MegaAccount" WHERE "userId" = ${sqFirstUser} AND status <> 'DISCONNECTED'`;
const pgAccIds = pgScope.map((r) => r.id);
console.log(`scope: user=${sqFirstUser} sqliteAccounts=${sqAccIds.length} pgAccounts=${pgAccIds.length}\n`);

for (const query of QUERIES) {
  const sqIds = oldEngine(query, sqAccIds);
  const ast = parseSearchQuery(query);
  const filter = buildSearchFilterSql(ast);
  const rank = buildSearchRankSql(ast);
  const scope = Prisma.sql`(v."megaAccountId" IS NULL OR v."megaAccountId" IN (${Prisma.join(pgAccIds)}))`;
  const where = Prisma.sql`${scope} AND ${filter}`;
  const full = rank
    ? Prisma.sql`SELECT v."id" AS id, ${rank} AS rank FROM "Video" AS v WHERE ${where} ORDER BY rank ASC, v."createdAt" DESC, v."id" DESC`
    : Prisma.sql`SELECT v."id" AS id, NULL::float8 AS rank FROM "Video" AS v WHERE ${where} ORDER BY v."createdAt" DESC, v."id" DESC`;
  let pgIds;
  try {
    const rows = await prisma.$queryRaw(full);
    pgIds = rows.map((r) => Number(r.id));
  } catch (e) {
    console.log('PG FAIL for', JSON.stringify(query), '->', e.message?.slice(0, 120));
    allSets = false;
    continue;
  }
  const setA = [...new Set(sqIds)].sort((a, b) => a - b);
  const setB = [...new Set(pgIds)].sort((a, b) => a - b);
  const setMatch = JSON.stringify(setA) === JSON.stringify(setB);
  const orderMatch = JSON.stringify(sqIds) === JSON.stringify(pgIds);
  if (!setMatch) allSets = false;
  // Top-5 overlap: the user-visible first page must be reasonably equivalent.
  let top5 = 'n/a';
  if (sqIds.length > 0 && pgIds.length > 0) {
    const a5 = new Set(sqIds.slice(0, 5));
    const b5 = new Set(pgIds.slice(0, 5));
    const inter = [...a5].filter((x) => b5.has(x)).length;
    top5 = `${inter}/5`;
  }
  console.log(
    JSON.stringify(query).padEnd(28),
    String(sqIds.length).padEnd(4),
    setMatch ? 'YES' : 'NO ',
    orderMatch ? 'YES' : 'NO ',
    top5,
  );
  if (!setMatch && setA.length <= 10) {
    console.log('   sqlite:', setA.join(','));
    console.log('   pg    :', setB.join(','));
  }
}
console.log(allSets ? '\nPARITY: all result sets match.' : '\nPARITY: differences above need review.');

await prisma.$disconnect();
sqlite.close();

function tokenizePublic(input) {
  const tokens = [];
  let cur = '';
  let has = false;
  const flush = () => {
    if (!has) return;
    const value = cur.trim().replace(/\s+/g, ' ');
    if (value) tokens.push({ kind: 'term', value });
    cur = '';
    has = false;
  };
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === '"') {
      const close = input.indexOf('"', i + 1);
      const content = close === -1 ? input.slice(i + 1) : input.slice(i + 1, close);
      cur += content;
      has = true;
      i = close === -1 ? input.length : close + 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      flush();
      tokens.push({ kind: ch === '(' ? 'lp' : 'rp' });
      i++;
      continue;
    }
    if (ch === '!' && !has) {
      flush();
      tokens.push({ kind: 'not' });
      i++;
      continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      flush();
      tokens.push({ kind: 'and' });
      i += 2;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      flush();
      tokens.push({ kind: 'or' });
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      i++;
      continue;
    }
    cur += ch;
    has = true;
    i++;
  }
  flush();
  return tokens;
}
