/**
 * Find Duplicates: duplicate-CANDIDATE detection logic (pure, no I/O).
 *
 * MODEL (heuristic - never a proof of identical content):
 *
 * MEGA exposes no content hash for account files, and each upload gets a
 * fresh random file key - so neither `megaFa` handles nor `fileKeyEncrypted`
 * can identify identical content, and nothing is downloaded. Candidates are
 * therefore found from two independent signals that must BOTH agree:
 *
 *   1. Normalized title similarity (Jaro-Winkler, 0-100):
 *      filenames are reduced to a comparison key (see normalizeTitle) and
 *      must score >= 90. Filename similarity alone NEVER yields a deletable
 *      candidate - signal 2 is always required.
 *   2. Exact file-size equality (both sizes valid and positive).
 *
 * Classification per pair:
 *
 *   HIGH CONFIDENCE possible duplicate:
 *     title similarity >= 95 AND sizes exactly equal AND durations
 *     compatible (both known -> within tolerance; either unknown -> allowed).
 *   POSSIBLE duplicate:
 *     title similarity 90-94 AND sizes exactly equal AND durations compatible.
 *   NOT a candidate:
 *     different sizes, similarity < 90, materially different durations, or a
 *     short/common title without an identical normalized form.
 *
 * A differing container/extension never auto-rejects a pair, but it caps the
 * group confidence at "possible" and is surfaced in the UI.
 *
 * Grouping is union-find over candidate edges. Pairwise similarity runs only
 * inside exact-size buckets (the expensive comparison is gated by the cheap
 * one), so large accounts stay practical. Scan results are transient -
 * nothing is persisted, no migration.
 *
 * NOTE on creator/title conventions: the normalization mirrors
 * lib/titles.ts (parseVideoMetadata/cleanMegaFilename/stripWatchPrefix)
 * without importing that module, which is coupled to the Prisma client and
 * would drag a DATABASE_URL requirement into this pure unit-testable module.
 */

export interface DuplicateCandidate {
  videoId: number;
  nodeId: string;
  name: string;
  parentNodeId: string | null;
  /** Size in bytes (null/0 = unknown - never groups). */
  size: number | null;
  /** Duration in whole seconds (null = unknown - allowed, never required). */
  duration: number | null;
  title: string;
  creatorName: string | null;
  thumbnail: string | null;
  mimeType: string | null;
  megaModifiedAt: string | null;
  /** Owning MegaAccount id - always set by server-side candidate queries. */
  accountId: number | null;
  /** Owning MegaAccount label for display - always set alongside accountId. */
  accountLabel: string | null;
}

export type DuplicateCopy = DuplicateCandidate;

export type DuplicateConfidence = 'high' | 'possible';

export type DuplicateDurationStatus = 'same' | 'partial-unknown' | 'unknown';

export interface DuplicateGroup {
  groupKey: string;
  copies: DuplicateCopy[];
  totalCopies: number;
  /** Bytes recoverable if all but one copy were deleted. */
  potentialSavings: number;
  representativeTitle: string;
  confidence: DuplicateConfidence;
  /** Minimum pairwise title-similarity across the group's candidate edges. */
  minTitleSim: number;
  /** Exact shared size in bytes (candidacy always requires size equality). */
  sameSizeBytes: number;
  durationStatus: DuplicateDurationStatus;
  /** Representative duration in seconds (median of known), null when unknown. */
  representativeDuration: number | null;
  /** Distinct container extensions in the group (lowercased, sorted). */
  extensions: string[];
}

export interface DuplicatesResult {
  groups: DuplicateGroup[];
  /**
   * Retired by the candidate model (the old "same size, unproven" category no
   * longer exists: every group carries its own confidence instead). Kept as
   * an empty array so the API shape stays stable for existing consumers.
   */
  potentialGroups: DuplicateGroup[];
  summary: {
    duplicateGroups: number;
    duplicateFiles: number;
    potentialSavingsBytes: number;
    potentialGroups: number;
    scannedVideos: number;
  };
}

// ---------------------------------------------------------------------------
// Tunables (exported for tests)
// ---------------------------------------------------------------------------

/** >= 95: very strong title match (high-confidence candidate with size). */
export const TITLE_SIM_HIGH = 95;
/** >= 90: strong title match (possible candidate with size). Below: no. */
export const TITLE_SIM_MIN = 90;
/** Durations within this many seconds count as "same" (container rounding). */
export const DURATION_TOLERANCE_S = 2;
/** Normalized titles shorter than this are too generic to trust. */
export const MIN_TITLE_LEN = 4;
/** Below this normalized length, only an identical form may group. */
export const SHORT_TITLE_LEN = 8;
/** Size buckets larger than this skip pairwise scoring (identical keys only). */
export const MAX_PAIRWISE_BUCKET = 500;

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

/** Lowercased container extension ('' when none). Never a grouping signal alone. */
export function extensionOf(filename: string | null | undefined): string {
  if (!filename) return '';
  const i = filename.lastIndexOf('.');
  if (i <= 0 || i === filename.length - 1) return '';
  return filename.slice(i + 1).toLowerCase();
}

function basenameOf(filename: string): string {
  const slash = filename.lastIndexOf('/');
  const back = filename.lastIndexOf('\\');
  const cut = Math.max(slash, back);
  return cut >= 0 ? filename.slice(cut + 1) : filename;
}

/**
 * Strip one trailing duplicate marker (" (1)", " - copy", " copy 2",
 * "duplicate", " [3]", ...). Returns null when nothing (more) strips, so the
 * caller can loop. Word markers ("copy"/"duplicate") only strip when a
 * meaningful stem remains, so a real title like "The Copy" is preserved;
 * bare numeric markers strip whenever a stem remains.
 */
function stripOneDuplicateSuffix(lower: string): string | null {
  // Bare numeric marker: "Video (1)", "Video - 2", "Video [12]".
  const numeric = lower.match(/^(.*\S)\s*[-\._\s]*[\(\[]\s*\d{1,3}\s*[\)\]]\s*$/) ??
    lower.match(/^(.*\S)\s+-\s*\d{1,3}\s*$/);
  if (numeric && numeric[1].trim()) return numeric[1].trim();
  // Word marker: "Video copy", "Video - Copy 1", "Video (duplicate)".
  const word = lower.match(/^(.*\S)\s+[-\._]?\s*\(?\s*(copy(\s*\d+)?|duplicates?)\s*\)?\s*$/);
  if (word) {
    const stem = word[1].trim();
    // Keep short stems intact ("The Copy" stays "The Copy").
    if (stem.length >= MIN_TITLE_LEN) return stem;
  }
  return null;
}

/**
 * Reduce a MEGA filename to a title comparison key.
 *
 * Pipeline (mirrors lib/titles.ts conventions):
 *   basename -> drop download "Watch_" prefix -> strip extension -> casefold
 *   -> duplicate-suffix stripping (so "Video - Copy" keeps title "Video") ->
 *   creator/title split on the FIRST " - " (or "_-_") keeping the title part
 *   (a leading "Watch " is only ever stripped from a creator segment, never
 *   from a title-only filename) -> underscores to spaces ->
 *   punctuation to spaces -> collapse spaces.
 */
export function normalizeTitle(filename: string | null | undefined): string {
  if (!filename) return '';
  let s = basenameOf(filename);
  // Download-source prefix (mirror cleanMegaFilename's "Watch_" rule).
  s = s.replace(/^watch_/i, '');
  // Extension.
  s = s.replace(/\.[^.]+$/, '');
  // Casefold early: every later step is case-invariant.
  let title = s.normalize('NFKC').toLowerCase();
  // Duplicate markers first: a trailing " - Copy"/" (1)" belongs to the
  // whole filename ("Amazing Video - Copy" is the video "Amazing Video",
  // not a creator called "Amazing Video").
  let prev: string | null;
  do {
    prev = title;
    const stripped = stripOneDuplicateSuffix(title);
    if (stripped !== null) title = stripped;
  } while (title !== prev);
  // Creator/title split on the marker-free string (mirror
  // parseVideoMetadata priorities): FIRST " - " wins, "_-_" is the fallback.
  // A leading "Watch " is only ever a creator-segment prefix (handled by the
  // split itself); title-only filenames keep their full text.
  let split = title;
  const spaced = title.indexOf(' - ');
  if (spaced > 0) {
    split = title.slice(spaced + 3);
  } else {
    const under = title.indexOf('_-_');
    if (under > 0) split = title.slice(under + 3);
  }
  title = split.replace(/_+/g, ' ');
  // Punctuation (unicode-aware) becomes word separators; words survive.
  title = title.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  return title.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Jaro-Winkler similarity (0-100, rounded)
// ---------------------------------------------------------------------------

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const alen = a.length;
  const blen = b.length;
  if (alen === 0 || blen === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(alen, blen) / 2) - 1);
  const aMatch = new Array<boolean>(alen).fill(false);
  const bMatch = new Array<boolean>(blen).fill(false);
  let matches = 0;
  for (let i = 0; i < alen; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(blen - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatch[j] && a[i] === b[j]) {
        aMatch[i] = true;
        bMatch[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < alen; i++) {
    if (aMatch[i]) {
      while (!bMatch[k]) k++;
      if (a[i] !== b[k]) transpositions++;
      k++;
    }
  }
  transpositions /= 2;
  return (matches / alen + matches / blen + (matches - transpositions) / matches) / 3;
}

/**
 * Normalized title similarity, 0-100 (rounded). Jaro-Winkler rewards shared
 * prefixes, which suits titles ("Amazing Video" vs "Amazing Videos"), while
 * unrelated titles score well below the 90 candidate floor.
 */
export function titleSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const j = jaro(a, b);
  let prefix = 0;
  while (prefix < 4 && prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  return Math.round((j + prefix * 0.1 * (1 - j)) * 100);
}

// ---------------------------------------------------------------------------
// Pair classification
// ---------------------------------------------------------------------------

function toSize(c: DuplicateCandidate): number | null {
  if (typeof c.size !== 'number' || !Number.isFinite(c.size) || c.size <= 0) return null;
  return Math.floor(c.size);
}

function toDuration(c: DuplicateCandidate): number | null {
  if (typeof c.duration !== 'number' || !Number.isFinite(c.duration) || c.duration <= 0) return null;
  return Math.floor(c.duration);
}

type EdgeClass = 'high' | 'possible';

interface CandidateEdge {
  a: number;
  b: number;
  sim: number;
  cls: EdgeClass;
}

/**
 * Classify one pair. Returns null when the pair is NOT a duplicate
 * candidate. Size equality is mandatory; title similarity must clear the
 * floor (identical form required for short titles); materially different
 * durations veto even strong title matches; unknown duration never vetoes.
 */
function classifyPair(
  a: DuplicateCandidate,
  normA: string,
  b: DuplicateCandidate,
  normB: string,
): CandidateEdge | null {
  const sizeA = toSize(a);
  const sizeB = toSize(b);
  if (sizeA === null || sizeB === null || sizeA !== sizeB) return null;
  if (!normA || !normB) return null;
  if (normA.length < MIN_TITLE_LEN || normB.length < MIN_TITLE_LEN) return null;
  const sim = titleSimilarity(normA, normB);
  if (sim < TITLE_SIM_MIN) return null;
  if (Math.min(normA.length, normB.length) < SHORT_TITLE_LEN && sim !== 100) return null;
  const durA = toDuration(a);
  const durB = toDuration(b);
  if (durA !== null && durB !== null && Math.abs(durA - durB) > DURATION_TOLERANCE_S) {
    return null;
  }
  return { a: -1, b: -1, sim, cls: sim >= TITLE_SIM_HIGH ? 'high' : 'possible' };
}

// ---------------------------------------------------------------------------
// Grouping (union-find over candidate edges within size buckets)
// ---------------------------------------------------------------------------

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Group duplicate candidates. Pure function (no I/O) - fully unit-testable.
 *
 * `groups` are POSSIBLE duplicates (never proven identical): each carries its
 * confidence and the evidence behind it (title match %, shared size,
 * duration status, extensions). Grouping is account-blind by design: pooled
 * candidates from several accounts form cross-account groups, and the
 * account label travels on each copy for display. The destructive workflow
 * deletes only explicitly selected nodes and still refuses to wipe a whole
 * group.
 */
export function findDuplicateGroups(candidates: DuplicateCandidate[]): DuplicatesResult {
  const items = candidates
    .filter((c) => c.nodeId)
    .map((c) => ({ c: { ...c }, norm: normalizeTitle(c.name), size: toSize(c) }));

  // Inexpensive bucketing first: candidacy requires exact size equality, so
  // similarity (the expensive step) only runs inside size buckets.
  const bySize = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    const size = items[i].size;
    if (size === null) continue;
    const list = bySize.get(size);
    if (list) list.push(i);
    else bySize.set(size, [i]);
  }

  // Union-find over candidate indices.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let root = parent.get(x) ?? x;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) ?? root;
    let cur = x;
    while ((parent.get(cur) ?? cur) !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (x: number, y: number): void => {
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  /** Pairwise classify (i, j) and union on candidacy. `i`/`j` are item indices. */
  const consider = (edges: CandidateEdge[], i: number, j: number): void => {
    const edge = classifyPair(items[i].c, items[i].norm, items[j].c, items[j].norm);
    if (!edge) return;
    edge.a = i;
    edge.b = j;
    edges.push(edge);
    union(i, j);
  };

  const edges: CandidateEdge[] = [];
  for (const idx of bySize.values()) {
    if (idx.length < 2) continue;
    if (idx.length > MAX_PAIRWISE_BUCKET) {
      // Pathological bucket (thousands of same-byte files): only identical
      // normalized keys may group, via map lookup instead of O(k^2).
      const byNorm = new Map<string, number[]>();
      for (const i of idx) {
        const key = items[i].norm;
        if (!key) continue;
        const list = byNorm.get(key);
        if (list) list.push(i);
        else byNorm.set(key, [i]);
      }
      for (const group of byNorm.values()) {
        for (let x = 0; x < group.length; x++) {
          for (let y = x + 1; y < group.length; y++) consider(edges, group[x], group[y]);
        }
      }
      continue;
    }
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) consider(edges, idx[x], idx[y]);
    }
  }

  // Assemble groups from union-find sets (dedupe identical node handles:
  // the same node is never a "duplicate" of itself).
  const inEdge = new Set<number>();
  for (const e of edges) {
    inEdge.add(e.a);
    inEdge.add(e.b);
  }
  const sets = new Map<number, number[]>();
  for (let i = 0; i < items.length; i++) {
    if (!inEdge.has(i)) continue;
    const root = find(i);
    const list = sets.get(root);
    if (list) list.push(i);
    else sets.set(root, [i]);
  }

  const edgesByPair = new Map<string, CandidateEdge[]>();
  for (const e of edges) {
    const key = `${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`;
    const list = edgesByPair.get(key);
    if (list) list.push(e);
    else edgesByPair.set(key, [e]);
  }

  const groups: DuplicateGroup[] = [];
  const keyCounts = new Map<string, number>();
  for (const members of sets.values()) {
    const nodeSeen = new Map<string, number>();
    for (const i of members) {
      if (!nodeSeen.has(items[i].c.nodeId)) nodeSeen.set(items[i].c.nodeId, i);
    }
    if (nodeSeen.size < 2) continue;
    const idxs = [...nodeSeen.values()];
    // Evidence across the group's candidate edges.
    let minSim = 100;
    let allHigh = true;
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const key = `${Math.min(idxs[x], idxs[y])}:${Math.max(idxs[x], idxs[y])}`;
        // Transitive members need not share a direct edge (A-B, B-C unions
        // A,B,C); only direct edges contribute evidence.
        for (const e of edgesByPair.get(key) ?? []) {
          if (e.sim < minSim) minSim = e.sim;
          if (e.cls !== 'high') allHigh = false;
        }
      }
    }
    const copies = idxs
      .map((i) => items[i].c)
      .sort((p, q) => p.videoId - q.videoId);
    const size = toSize(copies[0]) ?? 0;
    const knownDurations = copies
      .map((c) => toDuration(c))
      .filter((d): d is number => d !== null);
    const durationStatus: DuplicateDurationStatus =
      knownDurations.length === 0
        ? 'unknown'
        : knownDurations.length === copies.length &&
            Math.max(...knownDurations) - Math.min(...knownDurations) <= DURATION_TOLERANCE_S
          ? 'same'
          : 'partial-unknown';
    const extensions = [...new Set(copies.map((c) => extensionOf(c.name)))].sort();
    const confidence: DuplicateConfidence =
      allHigh && extensions.length <= 1 ? 'high' : 'possible';
    const baseKey = `possible|${size}|${fnv1a(idxs.map((i) => items[i].norm).sort().join('\n'))}`;
    const n = (keyCounts.get(baseKey) ?? 0) + 1;
    keyCounts.set(baseKey, n);
    groups.push({
      groupKey: n === 1 ? baseKey : `${baseKey}|${n}`,
      copies,
      totalCopies: copies.length,
      potentialSavings: size * (copies.length - 1),
      representativeTitle: copies[0].title || copies[0].name,
      confidence,
      minTitleSim: minSim,
      sameSizeBytes: size,
      durationStatus,
      representativeDuration: knownDurations.length > 0 ? median(knownDurations) : null,
      extensions,
    });
  }

  groups.sort((a, b) => b.potentialSavings - a.potentialSavings);

  return {
    groups,
    potentialGroups: [],
    summary: {
      duplicateGroups: groups.length,
      duplicateFiles: groups.reduce((n, g) => n + g.totalCopies, 0),
      potentialSavingsBytes: groups.reduce((n, g) => n + g.potentialSavings, 0),
      potentialGroups: 0,
      scannedVideos: candidates.length,
    },
  };
}

/**
 * Safety rail for deletion: the server must never delete EVERY copy of a
 * detected group (that would destroy the video entirely). Returns the group
 * keys that would be wiped out by `nodeIds`, or [] when safe. Applies to
 * candidate groups exactly as it did to exact groups: heuristic detection
 * never weakens this guard.
 */
export function findGroupsWipedOut(
  groups: DuplicateGroup[],
  nodeIds: ReadonlySet<string>,
): string[] {
  const wiped: string[] = [];
  for (const g of groups) {
    if (g.copies.length > 0 && g.copies.every((c) => nodeIds.has(c.nodeId))) {
      wiped.push(g.groupKey);
    }
  }
  return wiped;
}

// ---------------------------------------------------------------------------
// Deletion authorization helper (pure - user scoping lives in the DB query)
// ---------------------------------------------------------------------------

/** A Video row already scoped to the requesting user (see route queries). */
export interface OwnedVideoRef {
  nodeId: string;
  videoId: number;
  megaAccountId: number;
}

export interface PartitionedDeletion {
  /** Requested nodes verified against user-owned rows, grouped by account. */
  byAccount: Map<number, OwnedVideoRef[]>;
  /** Requested ids with no matching user-owned row (unknown, already gone,
   *  or another user's node - indistinguishable by design). */
  unknownNodeIds: string[];
}

/**
 * Partition explicitly requested node ids into per-account deletion targets.
 *
 * `rows` MUST come from a user-scoped query (e.g.
 * `where: { megaNodeId: { in: ids }, megaAccount: { userId } }`) - anything
 * not present in `rows` is rejected, so a browser-supplied id can never
 * resolve to another user's node. Pure function - fully unit-testable.
 */
export function partitionDeletionTargets(
  rows: OwnedVideoRef[],
  requestedNodeIds: readonly string[],
): PartitionedDeletion {
  const byNode = new Map(rows.map((r) => [r.nodeId, r]));
  const byAccount = new Map<number, OwnedVideoRef[]>();
  const unknownNodeIds: string[] = [];
  for (const nodeId of requestedNodeIds) {
    const row = byNode.get(nodeId);
    if (!row) {
      unknownNodeIds.push(nodeId);
      continue;
    }
    const list = byAccount.get(row.megaAccountId);
    if (list) list.push(row);
    else byAccount.set(row.megaAccountId, [row]);
  }
  return { byAccount, unknownNodeIds };
}
