/**
 * Boolean search tests: parser, precedence, FTS5 semantics, BM25 ranking,
 * NOT handling, authorization scope, malformed queries, and injection
 * safety (lib/search.ts + lib/videos.ts searchVideos).
 *
 * Fixtures (all private to userA unless noted):
 *   V1 "Newton invented gravity while eating apple"   (oldest)
 *   V2 "Plank was a great scientist but he hated apple" (middle)
 *   V3 "Einstein was a great scientist"               (newest)
 *
 * createdAt is set explicitly so recency order (V3 > V2 > V1) OPPOSES the
 * expected relevance order for `newton apple` (V1 > V2): the ranking test
 * can only pass via BM25, never via insertion/recency order.
 *
 * Runs against an isolated DB built from the repo migrations (FTS included).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from './helpers/test-db';

const db = createTestDatabase('search-boolean-unit');
process.env.DATABASE_URL = db.url;

let prisma: typeof import('@/lib/db')['prisma'];
let videos: typeof import('@/lib/videos');
let search: typeof import('@/lib/search');
let MEGA_ACCOUNT_STATUSES: typeof import('@/lib/megaAccounts')['MEGA_ACCOUNT_STATUSES'];
let searchVideos: typeof videos.searchVideos;
let searchVideosLiteral: typeof videos.searchVideosLiteral;

after(() => {
  db.close();
});

const PASSWORD_HASH =
  'pbkdf2:sha256:100000:00000000000000000000000000000000:000000000000000000000000000000000000000000000000000000000000000000';

let userA!: { id: string };
let userB!: { id: string };

async function makeVideo(
  accountId: number | null,
  slug: string,
  title: string,
  createdAt: string,
) {
  return prisma.video.create({
    data: {
      megaAccountId: accountId,
      megaFilename: `${title}.mp4`,
      title,
      slug,
      creatorAssignment: 'none',
      fileSize: BigInt(1000),
      mimeType: 'video/mp4',
      createdAt: new Date(createdAt),
    },
  });
}

before(async () => {
  ({ prisma } = await import('@/lib/db'));
  videos = await import('@/lib/videos');
  search = await import('@/lib/search');
  ({ MEGA_ACCOUNT_STATUSES } = await import('@/lib/megaAccounts'));
  ({ searchVideos, searchVideosLiteral } = videos);

  userA = await prisma.user.create({ data: { email: 'bool-a@example.com', passwordHash: PASSWORD_HASH } });
  userB = await prisma.user.create({ data: { email: 'bool-b@example.com', passwordHash: PASSWORD_HASH } });
  const accA = await prisma.megaAccount.create({
    data: { userId: userA.id, label: 'Acc A', megaEmail: 'a@example.com', encryptedSession: 's', status: MEGA_ACCOUNT_STATUSES.SYNCED },
  });
  const accB = await prisma.megaAccount.create({
    data: { userId: userB.id, label: 'Acc B', megaEmail: 'b@example.com', encryptedSession: 's', status: MEGA_ACCOUNT_STATUSES.SYNCED },
  });

  // Recency order V3 > V2 > V1 (deliberately opposite to relevance for `newton apple`).
  await makeVideo(accA.id, 'bool-v1', 'Newton invented gravity while eating apple', '2026-01-01T00:00:00Z');
  await makeVideo(accA.id, 'bool-v2', 'Plank was a great scientist but he hated apple', '2026-02-01T00:00:00Z');
  await makeVideo(accA.id, 'bool-v3', 'Einstein was a great scientist', '2026-03-01T00:00:00Z');
  // Another user's private apple video: must never leak into userA's search.
  await makeVideo(accB.id, 'bool-bsecret', 'Bee secret apple vault project', '2026-04-01T00:00:00Z');
});

const slugs = (r: { items: Array<{ slug: string }> }) => r.items.map((v) => v.slug);

// ---------------------------------------------------------------------------
// Parser: shape + precedence
// ---------------------------------------------------------------------------

test('parser: single term, implicit OR, explicit OR/AND/NOT', () => {
  const { parseSearchQuery, formatSearchAst } = search;
  assert.equal(formatSearchAst(parseSearchQuery('apple')), 'apple');
  assert.equal(formatSearchAst(parseSearchQuery('newton apple')), 'OR(newton, apple)');
  assert.equal(formatSearchAst(parseSearchQuery('newton || apple')), 'OR(newton, apple)');
  assert.equal(formatSearchAst(parseSearchQuery('newton && apple')), 'AND(newton, apple)');
  assert.equal(formatSearchAst(parseSearchQuery('!plank')), 'NOT(plank)');
  assert.equal(formatSearchAst(parseSearchQuery('apple && !plank')), 'AND(apple, NOT(plank))');
});

test('parser: precedence ! > && > || (implicit OR is lowest)', () => {
  const { parseSearchQuery, formatSearchAst } = search;
  assert.equal(
    formatSearchAst(parseSearchQuery('apple || newton && !plank')),
    'OR(apple, AND(newton, NOT(plank)))',
  );
  assert.equal(
    formatSearchAst(parseSearchQuery('newton apple && plank')),
    'OR(newton, AND(apple, plank))',
  );
  assert.equal(
    formatSearchAst(parseSearchQuery('!newton && apple || plank')),
    'OR(AND(NOT(newton), apple), plank)',
  );
});

test('parser: parentheses override precedence', () => {
  const { parseSearchQuery, formatSearchAst } = search;
  assert.equal(
    formatSearchAst(parseSearchQuery('(apple || newton) && !plank')),
    'AND(OR(apple, newton), NOT(plank))',
  );
  assert.equal(
    formatSearchAst(parseSearchQuery('apple && (newton || einstein)')),
    'AND(apple, OR(newton, einstein))',
  );
  assert.equal(formatSearchAst(parseSearchQuery('((apple))')), 'apple');
  assert.equal(
    formatSearchAst(parseSearchQuery('(newton || einstein) && !plank')),
    'AND(OR(newton, einstein), NOT(plank))',
  );
});

test('parser: harmless inputs stay literal, never errors', () => {
  const { parseSearchQuery, formatSearchAst } = search;
  assert.equal(formatSearchAst(parseSearchQuery('Wow!')), '"Wow!"');
  assert.equal(formatSearchAst(parseSearchQuery('R&D')), '"R&D"');
  assert.equal(formatSearchAst(parseSearchQuery('"eating apple"')), '"eating apple"');
  assert.equal(formatSearchAst(parseSearchQuery('#random test')), 'OR(#random, test)');
  assert.equal(formatSearchAst(parseSearchQuery('Galaxy (Tour)')), 'OR(Galaxy, Tour)');
  // Double negation is well-defined (NOT NOT x = x).
  assert.equal(formatSearchAst(parseSearchQuery('!!newton')), 'NOT(NOT(newton))');
});

test('parser: malformed queries throw SearchSyntaxError', () => {
  const { parseSearchQuery, SearchSyntaxError } = search;
  for (const q of [
    'apple &&',
    '&& apple',
    'apple ||',
    '||',
    '!',
    '!!',
    'apple && && newton',
    '(apple',
    'apple)',
    '()',
    '((apple)',
    'apple || (newton &&)',
    'apple && || newton',
    'apple && !',
    '',
    '   ',
    '""',
  ]) {
    assert.throws(() => parseSearchQuery(q), SearchSyntaxError, `query ${JSON.stringify(q)} must throw`);
  }
});

test('parser helpers: FTS escaping, LIKE escaping, eligibility', () => {
  assert.equal(search.ftsPhraseExpression('say "hi"'), '"say ""hi"""');
  assert.equal(search.likePattern('100%_\\'), '%100\\%\\_\\\\%');
  assert.equal(search.isFtsEligibleTerm('apple'), true);
  assert.equal(search.isFtsEligibleTerm('underwater-footage'), true);
  assert.equal(search.isFtsEligibleTerm('Al'), false);
  assert.equal(search.isFtsEligibleTerm('on'), false);
  assert.equal(search.isFtsEligibleTerm('strap on deal'), false);
  assert.deepEqual(search.positiveFtsTerms(search.parseSearchQuery('apple || newton && !plank')), ['apple', 'newton']);
  assert.deepEqual(search.positiveFtsTerms(search.parseSearchQuery('!plank')), []);
});

// ---------------------------------------------------------------------------
// Semantics (spec fixtures)
// ---------------------------------------------------------------------------

test('search: single term finds all matches, isolates users', async () => {
  const r = await searchVideos('apple', 1, userA.id);
  assert.deepEqual(slugs(r).sort(), ['bool-v1', 'bool-v2']);
  assert.equal(r.total, 2);
  assert.ok(!slugs(r).includes('bool-bsecret'), 'other user video never leaks');
});

test('search: implicit OR ranks the two-term match first (not insertion order)', async () => {
  const r = await searchVideos('newton apple', 1, userA.id);
  assert.equal(r.total, 2);
  // V1 is OLDER (loses on recency) but matches both terms: BM25 must win.
  assert.deepEqual(slugs(r), ['bool-v1', 'bool-v2']);
});

test('search: explicit OR behaves like implicit OR with ranking', async () => {
  const r = await searchVideos('newton || apple', 1, userA.id);
  assert.equal(r.total, 2);
  assert.deepEqual(slugs(r), ['bool-v1', 'bool-v2']);
});

test('search: explicit AND requires both terms', async () => {
  const r = await searchVideos('newton && apple', 1, userA.id);
  assert.deepEqual(slugs(r), ['bool-v1']);
  assert.equal(r.total, 1);
});

test('search: NOT-only returns everything except the match', async () => {
  const r = await searchVideos('!plank', 1, userA.id);
  assert.deepEqual(slugs(r).sort(), ['bool-v1', 'bool-v3']);
  assert.ok(!slugs(r).includes('bool-v2'));
});

test('search: AND + NOT excludes correctly', async () => {
  const r = await searchVideos('apple && !plank', 1, userA.id);
  assert.deepEqual(slugs(r), ['bool-v1']);
  assert.equal(r.total, 1);
});

test('search: reversed AND + NOT', async () => {
  const r = await searchVideos('plank && apple', 1, userA.id);
  assert.deepEqual(slugs(r), ['bool-v2']);
});

test('search: OR + NOT uses ! > && > || precedence', async () => {
  // apple OR (newton AND NOT plank): V1 (both branches) + V2 (apple branch).
  // The WRONG parse (apple OR newton) AND NOT plank would drop V2.
  const r = await searchVideos('apple || newton && !plank', 1, userA.id);
  assert.equal(r.total, 2);
  assert.deepEqual(slugs(r), ['bool-v1', 'bool-v2']);
});

test('search: parentheses group as written', async () => {
  const a = await searchVideos('(newton || plank) && apple', 1, userA.id);
  assert.deepEqual(slugs(a).sort(), ['bool-v1', 'bool-v2']);

  const b = await searchVideos('(newton || einstein) && !plank', 1, userA.id);
  assert.deepEqual(slugs(b).sort(), ['bool-v1', 'bool-v3']);

  const c = await searchVideos('apple && (newton || einstein)', 1, userA.id);
  assert.deepEqual(slugs(c), ['bool-v1']);
});

test('search: quoted phrase still means contiguous phrase', async () => {
  const r = await searchVideos('"eating apple"', 1, userA.id);
  assert.deepEqual(slugs(r), ['bool-v1']);
});

test('search: matching is case-insensitive', async () => {
  const r = await searchVideos('APPLE Newton', 1, userA.id);
  assert.deepEqual(slugs(r), ['bool-v1', 'bool-v2']);
});

test('search: double negation works', async () => {
  const r = await searchVideos('!!newton', 1, userA.id);
  assert.deepEqual(slugs(r), ['bool-v1']);
});

test('search: short terms use inline LIKE without breaking boolean logic', async () => {
  // 'ap' (< 3 chars) cannot use the trigram index but must still match.
  const r = await searchVideos('ap', 1, userA.id);
  assert.ok(slugs(r).includes('bool-v1'));
  // Mixed short + boolean: (ap) AND apple.
  const mixed = await searchVideos('ap && apple', 1, userA.id);
  assert.deepEqual(slugs(mixed).sort(), ['bool-v1', 'bool-v2']);
});

test('search: pagination partitions boolean results without overlap', async () => {
  const first = await searchVideos('apple || einstein', 1, userA.id);
  assert.equal(first.total, 3);
  const seen = new Set<number>();
  for (let p = 1; p <= first.totalPages; p++) {
    const r = await searchVideos('apple || einstein', p, userA.id);
    assert.equal(r.total, 3);
    for (const v of r.items) {
      assert.ok(!seen.has(v.id), `duplicate ${v.id}`);
      seen.add(v.id);
    }
  }
  assert.equal(seen.size, 3);
});

test('search: logged-out scope sees only public videos', async () => {
  const pub = await makeVideo(null, 'bool-pub', 'Public apple harvest festival', '2026-05-01T00:00:00Z');
  try {
    const anon = await searchVideos('apple', 1, undefined);
    assert.deepEqual(slugs(anon), ['bool-pub']);
    const and = await searchVideos('apple && harvest', 1, undefined);
    assert.deepEqual(slugs(and), ['bool-pub']);
    const not = await searchVideos('!plank', 1, undefined);
    assert.ok(slugs(not).includes('bool-pub'));
    assert.ok(!slugs(not).includes('bool-v1'), 'private videos hidden when logged out');
  } finally {
    await prisma.video.delete({ where: { id: pub.id } });
  }
});

// ---------------------------------------------------------------------------
// Malformed queries via the service
// ---------------------------------------------------------------------------

test('search: malformed queries reject with SearchSyntaxError', async () => {
  const { SearchSyntaxError } = search;
  for (const q of ['apple &&', '&& apple', 'apple ||', '||', '!', 'apple && && newton', '(apple', 'apple)', '()', 'apple || (newton &&)', 'apple && || newton']) {
    await assert.rejects(() => searchVideos(q, 1, userA.id), SearchSyntaxError, `query ${JSON.stringify(q)} must reject`);
  }
});

test('search: empty query keeps the empty result shape (no throw)', async () => {
  for (const q of ['', '   ']) {
    const r = await searchVideos(q, 1, userA.id);
    assert.equal(r.total, 0);
    assert.deepEqual(r.items, []);
  }
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test('search: FTS/SQL injection attempts are inert, table intact', async () => {
  const before = await prisma.video.count();
  assert.ok(before > 0);
  const attacks = [
    '" OR "1"="1',
    `' OR 1=1 --`,
    `'; DROP TABLE "Video"; --`,
    `apple" OR "x" LIKE "`,
    'apple || " OR true --',
    'newton && (apple',
    '\\',
    '100%_%',
    `o'brien`,
    'a/b\\c',
    'café',
    '42',
    '  apple    newton  ',
    '"',
    '&&&',
    '|||',
    '!(!(!apple))',
  ];
  for (const q of attacks) {
    let r;
    try {
      r = await searchVideos(q, 1, userA.id);
    } catch (e) {
      // Malformed boolean is a clean validation error, never a crash/leak.
      assert.ok(e instanceof search.SearchSyntaxError, `${JSON.stringify(q)} threw ${String(e)}`);
      continue;
    }
    assert.ok(Array.isArray(r.items), `${JSON.stringify(q)} returns a valid shape`);
    assert.ok(!slugs(r).includes('bool-bsecret'), `${JSON.stringify(q)} must not leak`);
  }
  assert.equal(await prisma.video.count(), before, 'Video table untouched by injection attempts');
  // Extra whitespace collapses to implicit OR with ranking intact.
  const spaced = await searchVideos('  apple    newton  ', 1, userA.id);
  assert.deepEqual(slugs(spaced), ['bool-v1', 'bool-v2']);
});

test('search: special characters in one term never break the query', async () => {
  for (const q of ['"quoted"', '(physics)', 'a*b', 'eating-apple', 'apple!']) {
    const r = await searchVideos(q, 1, userA.id);
    assert.ok(Array.isArray(r.items), `${q} returns a valid shape`);
  }
  const hyphen = await searchVideos('eating-apple', 1, userA.id);
  assert.ok(Array.isArray(hyphen.items));
});

// ---------------------------------------------------------------------------
// Literal path (recommendations feed raw titles here)
// ---------------------------------------------------------------------------

test('search: literal path treats operators as plain text', async () => {
  const tricky = await makeVideo(
    null,
    'bool-tricky',
    'Fish && Chips (Battered) !Yum test dish',
    '2026-06-01T00:00:00Z',
  );
  try {
    const r = await searchVideosLiteral('Fish && Chips (Battered) !Yum test dish', 1, undefined);
    assert.ok(slugs(r).includes('bool-tricky'), 'literal title search finds the video');
    const empty = await searchVideosLiteral('   ', 1, undefined);
    assert.equal(empty.total, 0);
  } finally {
    await prisma.video.delete({ where: { id: tricky.id } });
  }
});
