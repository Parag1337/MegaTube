/**
 * MegaTube boolean search language.
 *
 * Syntax:
 *   TERM                 a literal word/phrase (anything that is not an operator)
 *   TERM TERM            implicit OR (whitespace between terms)
 *   TERM || TERM         explicit OR
 *   TERM && TERM         explicit AND
 *   !TERM                NOT
 *   ( ... )              grouping (overrides precedence)
 *   "multi word"         one phrase term (quotes group, never split)
 *
 * Precedence (highest first):  !  >  &&  >  || (explicit or implicit)
 *
 * Design notes:
 * - The tokenizer never lets user input become SQL or FTS operators: every
 *   TERM is compiled to a bound parameter (a double-quoted FTS5 phrase with
 *   embedded quotes doubled, or a LIKE pattern with %/_/\ escaped). Boolean
 *   structure is rebuilt in SQL from the AST - user text only ever travels
 *   as parameter values.
 * - `!` is an operator only at a token boundary (start of input, after
 *   whitespace, `(`, `&&`, `||` or another `!`). Inside a word (`Wow!`,
 *   `apple!`) it is a literal character, so ordinary titles never become
 *   syntax errors.
 * - A single `&` or `|` is a literal character (`R&D`, `Tom & Jerry`);
 *   only the doubled forms `&&` / `||` are operators.
 * - `"` groups words into one phrase term; an unterminated quote is
 *   auto-closed at end of input (lenient, never a crash).
 */

import { Prisma } from '../generated/client';

export class SearchSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchSyntaxError';
  }
}

export type SearchNode =
  | { kind: 'term'; value: string }
  | { kind: 'not'; child: SearchNode }
  | { kind: 'and'; children: SearchNode[] }
  | { kind: 'or'; children: SearchNode[] };

type SearchToken =
  | { kind: 'term'; value: string }
  | { kind: 'and' }
  | { kind: 'or' }
  | { kind: 'not' }
  | { kind: 'lp' }
  | { kind: 'rp' };

function normalizeTermValue(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/**
 * Split a raw query into operator/term tokens. Never throws: anything that
 * is not recognizably an operator becomes literal term content.
 */
export function tokenizeSearchQuery(input: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  let current = '';
  let hasCurrent = false;
  const flush = () => {
    if (!hasCurrent) return;
    const value = normalizeTermValue(current);
    if (value.length > 0) tokens.push({ kind: 'term', value });
    current = '';
    hasCurrent = false;
  };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === '"') {
      // Quoted section: literal content up to the closing quote (auto-close
      // at end of input). Quotes group words into ONE phrase term.
      const close = input.indexOf('"', i + 1);
      const content = close === -1 ? input.slice(i + 1) : input.slice(i + 1, close);
      current += content;
      hasCurrent = true;
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      flush();
      tokens.push({ kind: ch === '(' ? 'lp' : 'rp' });
      i++;
      continue;
    }
    if (ch === '!' && !hasCurrent) {
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
    current += ch;
    hasCurrent = true;
    i++;
  }
  flush();
  return tokens;
}

function describeToken(t: SearchToken): string {
  switch (t.kind) {
    case 'and':
      return '"&&"';
    case 'or':
      return '"||"';
    case 'not':
      return '"!"';
    case 'lp':
      return '"("';
    case 'rp':
      return '")"';
    case 'term':
      return `"${t.value}"`;
  }
}

function orNode(left: SearchNode, right: SearchNode): SearchNode {
  return {
    kind: 'or',
    children: [
      ...(left.kind === 'or' ? left.children : [left]),
      ...(right.kind === 'or' ? right.children : [right]),
    ],
  };
}

function andNode(left: SearchNode, right: SearchNode): SearchNode {
  return {
    kind: 'and',
    children: [
      ...(left.kind === 'and' ? left.children : [left]),
      ...(right.kind === 'and' ? right.children : [right]),
    ],
  };
}

/**
 * Parse a raw user query into a boolean AST.
 *
 * Grammar (recursive descent, precedence ! > && > ||, whitespace = OR):
 *   or      := and ( ("||" | implicit) and )*
 *   and     := unary ( "&&" unary )*
 *   unary   := "!" unary | primary
 *   primary := TERM | "(" or ")"
 *
 * Throws SearchSyntaxError for malformed input. Never returns a partial AST.
 */
export function parseSearchQuery(input: string): SearchNode {
  const tokens = tokenizeSearchQuery(input);
  if (tokens.length === 0) {
    throw new SearchSyntaxError('Empty search expression.');
  }
  let pos = 0;
  const peek = (): SearchToken | undefined => tokens[pos];

  function parseOr(): SearchNode {
    let left = parseAnd();
    for (;;) {
      const t = peek();
      if (t === undefined) return left;
      if (t.kind === 'or') {
        pos++;
        left = orNode(left, parseAnd());
        continue;
      }
      // Whitespace between terms = implicit OR. A new operand can only
      // start with a term, `!` or `(`; anything else ends the expression
      // here (the top-level check then reports the leftover token).
      if (t.kind === 'term' || t.kind === 'not' || t.kind === 'lp') {
        left = orNode(left, parseAnd());
        continue;
      }
      return left;
    }
  }

  function parseAnd(): SearchNode {
    let left = parseUnary();
    while (peek()?.kind === 'and') {
      pos++;
      left = andNode(left, parseUnary());
    }
    return left;
  }

  function parseUnary(): SearchNode {
    if (peek()?.kind === 'not') {
      pos++;
      return { kind: 'not', child: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): SearchNode {
    const t = peek();
    if (t === undefined) {
      throw new SearchSyntaxError('Incomplete search expression: a search term was expected.');
    }
    if (t.kind === 'term') {
      pos++;
      return { kind: 'term', value: t.value };
    }
    if (t.kind === 'lp') {
      pos++;
      const inner = parseOr();
      if (peek()?.kind !== 'rp') {
        throw new SearchSyntaxError('Missing closing ")".');
      }
      pos++;
      return inner;
    }
    throw new SearchSyntaxError(`Unexpected ${describeToken(t)}: a search term was expected.`);
  }

  const ast = parseOr();
  const leftover = peek();
  if (leftover !== undefined) {
    throw new SearchSyntaxError(`Unexpected ${describeToken(leftover)}.`);
  }
  return ast;
}

/** Canonical s-expression for tests/debugging, e.g. `OR(apple, AND(newton, NOT(plank)))`. */
export function formatSearchAst(node: SearchNode): string {
  const fmtTerm = (value: string) =>
    /^[A-Za-z0-9_#-]+$/.test(value) ? value : JSON.stringify(value);
  switch (node.kind) {
    case 'term':
      return fmtTerm(node.value);
    case 'not':
      return `NOT(${formatSearchAst(node.child)})`;
    case 'and':
      return `AND(${node.children.map(formatSearchAst).join(', ')})`;
    case 'or':
      return `OR(${node.children.map(formatSearchAst).join(', ')})`;
  }
}

/**
 * Treat a raw string as ONE literal search term (no boolean parsing).
 * Used for internal callers that feed derived text (e.g. video titles in
 * recommendations) into the search engine: titles may legitimately contain
 * `&&`, `||`, `!` or parentheses.
 * Returns null for blank input.
 */
export function literalSearchNode(input: string): SearchNode | null {
  const value = normalizeTermValue(input);
  if (value.length === 0) return null;
  return { kind: 'term', value };
}

/**
 * Whether a term can use the FTS5 trigram index. Trigram queries with fewer
 * than 3 characters match nothing, so such terms are evaluated with LIKE
 * instead (same database-side query, different predicate).
 */
export function isFtsEligibleTerm(value: string): boolean {
  return value.split(/\s+/).every((piece) => piece.length >= 3);
}

/** Quote a term as a single FTS5 phrase (embedded quotes doubled). */
export function ftsPhraseExpression(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/** Escape LIKE wildcards so a term only ever matches literally. */
export function likePattern(value: string): string {
  return `%${value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

/**
 * Positive (non-negated) FTS-eligible terms, deduped, for relevance ranking.
 * Boolean filtering and ranking are separate concerns: the filter decides
 * eligibility, these terms decide the order via BM25.
 */
export function positiveFtsTerms(node: SearchNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: SearchNode, polarity: number) => {
    if (n.kind === 'term') {
      if (polarity > 0 && isFtsEligibleTerm(n.value) && !seen.has(n.value)) {
        seen.add(n.value);
        out.push(n.value);
      }
      return;
    }
    if (n.kind === 'not') {
      walk(n.child, -polarity);
      return;
    }
    for (const child of n.children) walk(child, polarity);
  };
  walk(node, 1);
  return out;
}

// ---------------------------------------------------------------------------
// SQL compilation (Prisma.sql fragments, user text only as bound parameters)
// ---------------------------------------------------------------------------

function termFilterSql(value: string): Prisma.Sql {
  if (isFtsEligibleTerm(value)) {
    return Prisma.sql`EXISTS(SELECT 1 FROM "VideoSearch" AS "s" WHERE "s"."rowid" = "v"."id" AND "s"."VideoSearch" MATCH ${ftsPhraseExpression(value)})`;
  }
  const pattern = likePattern(value);
  return Prisma.sql`("v"."title" LIKE ${pattern} ESCAPE '\' OR "v"."megaFilename" LIKE ${pattern} ESCAPE '\' OR EXISTS(SELECT 1 FROM "Creator" AS "c" WHERE "c"."id" = "v"."creatorId" AND "c"."name" LIKE ${pattern} ESCAPE '\'))`;
}

/**
 * Compile the AST to a SQL boolean predicate over the `v` ("Video") alias.
 * Each TERM becomes one index-backed EXISTS(MATCH) probe (or an inline LIKE
 * for sub-trigram terms); AND/OR/NOT compose in plain SQL. One query, no
 * per-term round trips, no JavaScript filtering.
 */
export function buildSearchFilterSql(node: SearchNode): Prisma.Sql {
  switch (node.kind) {
    case 'term':
      return termFilterSql(node.value);
    case 'not':
      return Prisma.sql`(NOT ${buildSearchFilterSql(node.child)})`;
    case 'and': {
      let acc = buildSearchFilterSql(node.children[0]);
      for (let i = 1; i < node.children.length; i++) {
        acc = Prisma.sql`(${acc} AND ${buildSearchFilterSql(node.children[i])})`;
      }
      return acc;
    }
    case 'or': {
      let acc = buildSearchFilterSql(node.children[0]);
      for (let i = 1; i < node.children.length; i++) {
        acc = Prisma.sql`(${acc} OR ${buildSearchFilterSql(node.children[i])})`;
      }
      return acc;
    }
  }
}

/**
 * BM25 relevance over the OR of all positive terms (scalar subquery, NULL
 * for rows that match no positive term - e.g. pure-NOT results). Title is
 * weighted above filename/creator (FTS column order title, filename,
 * creator). Returns null when there is nothing rankable (NOT-only queries);
 * callers then fall back to recency ordering.
 */
export function buildSearchRankSql(node: SearchNode): Prisma.Sql | null {
  const terms = positiveFtsTerms(node);
  if (terms.length === 0) return null;
  const match = terms.map(ftsPhraseExpression).join(' OR ');
  return Prisma.sql`(SELECT bm25("VideoSearch", 2.0, 1.0, 1.0) FROM "VideoSearch" AS "r" WHERE "r"."rowid" = "v"."id" AND "r"."VideoSearch" MATCH ${match})`;
}

// ---------------------------------------------------------------------------
// Prisma fallback (pre-migration databases without the VideoSearch table)
// ---------------------------------------------------------------------------

/** Compile the AST to a Prisma where-input with LIKE `contains` per term. */
export function buildSearchPrismaWhere(node: SearchNode): Prisma.VideoWhereInput {
  switch (node.kind) {
    case 'term':
      return {
        OR: [
          { title: { contains: node.value } },
          { megaFilename: { contains: node.value } },
          { creator: { is: { name: { contains: node.value } } } },
        ],
      };
    case 'not':
      return { NOT: buildSearchPrismaWhere(node.child) };
    case 'and':
      return { AND: node.children.map(buildSearchPrismaWhere) };
    case 'or':
      return { OR: node.children.map(buildSearchPrismaWhere) };
  }
}
