/**
 * Single source of truth for "what container does this media actually contain?".
 *
 * Playback routing historically trusted the stored `Video.mimeType` string:
 * `needsRemuxPlayback(mime) === (mime === 'video/mp2t')`. That string is
 * assigned at sync time from the filename extension only
 * (`lib/sync/syncAccount.ts`) — MEGA nodes carry no MIME — so a `.mp4` name
 * holding MPEG-TS bytes (or vice versa) misroutes playback. The media route
 * previously self-healed only one direction (mp4 label + TS bytes -> persist
 * mp2t); mp2t labels were never re-verified, so a true MP4 behind an mp2t
 * label entered the slow remux path forever, and each duplicate Video row for
 * the same MEGA node kept its own stale label.
 *
 * This module owns the corrected policy:
 *   1. `needsRemuxForContainer(storedMime)` == the old rule (only
 *      `video/mp2t` remuxes), shared by callers so routing never forks.
 *   2. `probeMediaContainer()` verifies the actual bytes via the existing
 *      cheap 188-byte prefix probe (`decryptPrefixToBuffer` + sniff) — never
 *      a full download — and returns one of two verdicts:
 *        - 'mp2t': bytes are MPEG-TS -> remux; persist `video/mp2t`.
 *        - 'mp4' : bytes are NOT MPEG-TS (genuine MP4 or undetectable) ->
 *                  direct path; persist `video/mp4` only when bytes PROVE
 *                  mp4 (ftyp/box header). Undetectable bytes keep the stored
 *                  label untouched and follow the safe existing fallback.
 *   3. A short-lived in-memory verdict cache (keyed `megaNodeId:size`) so a
 *      player probe + main request, or duplicate rows for the same MEGA file,
 *      share one verdict. Single-flight joins concurrent probes. Download,
 *      thumbnail, sync, cache-key, and remux code are untouched.
 */

import { sniffMimeType } from '../mega/nodes';

/** How the route should treat the source after container truth is known. */
export type MediaContainerVerdict = 'mp2t' | 'mp4';

/** Pure routing decision shared by every playback caller (== old rule). */
export function needsRemuxForContainer(mimeType: string | null | undefined): boolean {
  return mimeType === 'video/mp2t';
}

/** What the 188-byte probe observed (exported for tests). */
export type ContainerProbeObservation =
  | { kind: 'ts' }
  | { kind: 'mp4' }
  | { kind: 'unknown' };

/**
 * Classify decrypted prefix bytes with the existing sniffer. TS sync bytes
 * -> 'ts'; a positive 'video/mp4' box-header detection -> 'mp4'; anything
 * else (webm/avi/null) -> 'unknown' so callers keep the safe fallback and
 * never assume MP4.
 */
export function observeContainerBytes(prefixPlain: Buffer): ContainerProbeObservation {
  const detected = sniffMimeType(prefixPlain);
  if (detected === 'video/mp2t') return { kind: 'ts' };
  if (detected === 'video/mp4') return { kind: 'mp4' };
  return { kind: 'unknown' };
}

export interface ContainerProbeDeps {
  /** Fetch ciphertext bytes for `url/0-187` (route: MediaDeps.fetchCiphertext). */
  fetchCiphertext: (url: string) => Promise<Response>;
  /**
   * Decrypt the 188-byte prefix. Defaults to the real megajs helper via a
   * lazy import so this module never creates a static cycle with
   * `./remux` (which owns `decryptPrefixToBuffer` and imports the routing
   * rule back from here). Tests inject a stub to avoid real crypto.
   */
  decryptPrefix?: (fileKey: Buffer, cipherPrefix: Buffer) => Promise<Buffer>;
}

export interface ContainerProbeInput {
  nodeId: string;
  downloadUrl: string;
  sourceSize: number;
  fileKey: Buffer;
  storedMimeType: string | null | undefined;
}

const CONTAINER_PROBE_BYTES = 188;
/** Verdict cache TTL: covers a player probe + main request for one viewing. */
const CONTAINER_VERDICT_TTL_MS = 5 * 60 * 1000;

/**
 * What the cache stores per node: the BYTES-level observation plus when it
 * was observed. The routing decision (verdict + whether the stored label is
 * stale) is re-derived per request via `decideContainerRouting(storedLabel,
 * observation)`, so duplicate Video rows for the same MEGA file can never
 * inherit each other's fallback: a cached 'unknown' keeps every row on its
 * own stored-label path, and a cached 'ts'/'mp4' corrects only rows whose
 * label still disagrees.
 */
interface ContainerCacheEntry {
  observation: ContainerProbeObservation;
  expiresAt: number;
}

const containerVerdictCache = new Map<string, ContainerCacheEntry>();
const containerProbeInflight = new Map<string, Promise<ContainerCacheEntry>>();

function containerCacheKey(nodeId: string, sourceSize: number): string {
  return `${nodeId}:${sourceSize}`;
}

/** Test hook: clear the in-memory verdict cache + in-flight probes. */
export function clearContainerVerdictCacheForTests(): void {
  containerVerdictCache.clear();
  containerProbeInflight.clear();
}

export interface ContainerProbeResult {
  verdict: MediaContainerVerdict;
  /**
   * Non-null when the bytes proved the stored label wrong: persist exactly
   * this string to the affected Video row (mimeType column ONLY).
   */
  correctedMimeType: 'video/mp4' | 'video/mp2t' | null;
  /** True when the verdict came from cache (no byte fetch performed). */
  fromCache: boolean;
}

/**
 * Decide routing + persistence from the stored label and the probe
 * observation. Pure (no I/O) so unit tests pin the full decision table:
 *
 *   stored=mp4 + TS bytes    -> remux, correct label to mp2t
 *   stored=mp4 + MP4 bytes   -> direct, label correct (no write)
 *   stored=mp2t + MP4 bytes  -> direct, correct label to mp4
 *   stored=mp2t + TS bytes   -> remux, label correct (no write)
 *   either + unknown bytes   -> keep stored label, follow it (safe fallback:
 *                               never assume MP4, never force remux)
 */
export function decideContainerRouting(
  storedMimeType: string | null | undefined,
  observation: ContainerProbeObservation,
): { verdict: MediaContainerVerdict; correctedMimeType: string | null } {
  const storedIsTs = needsRemuxForContainer(storedMimeType);
  if (observation.kind === 'ts') {
    return storedIsTs
      ? { verdict: 'mp2t', correctedMimeType: null }
      : { verdict: 'mp2t', correctedMimeType: 'video/mp2t' };
  }
  if (observation.kind === 'mp4') {
    return storedIsTs
      ? { verdict: 'mp4', correctedMimeType: 'video/mp4' }
      : { verdict: 'mp4', correctedMimeType: null };
  }
  return storedIsTs
    ? { verdict: 'mp2t', correctedMimeType: null }
    : { verdict: 'mp4', correctedMimeType: null };
}

/**
 * Verify the actual container with the existing minimal 188-byte probe and
 * map it through the shared decision table. Throws only when the prefix
 * cannot be fetched/decrypted at all — callers treat that as "probe
 * inconclusive" and keep the stored-label fallback (never a new failure
 * mode for direct MP4 playback).
 */
export async function probeMediaContainer(
  input: ContainerProbeInput,
  deps: ContainerProbeDeps,
): Promise<ContainerProbeResult> {
  const key = containerCacheKey(input.nodeId, input.sourceSize);
  const decideFor = (observation: ContainerProbeObservation, fromCache: boolean): ContainerProbeResult => {
    const decision = decideContainerRouting(input.storedMimeType, observation);
    return { verdict: decision.verdict, correctedMimeType: decision.correctedMimeType as ContainerProbeResult['correctedMimeType'], fromCache };
  };
  const cached = containerVerdictCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return decideFor(cached.observation, true);
  }
  const inflight = containerProbeInflight.get(key);
  if (inflight) {
    const shared = await inflight;
    return decideFor(shared.observation, true);
  }
  const run = (async (): Promise<ContainerCacheEntry> => {
    const prefixRes = await deps.fetchCiphertext(`${input.downloadUrl}/0-${CONTAINER_PROBE_BYTES - 1}`);
    if (!prefixRes.ok) {
      throw new Error(`container probe fetch failed with status ${prefixRes.status}`);
    }
    const cipherPrefix = Buffer.from(await prefixRes.arrayBuffer());
    const decrypt = deps.decryptPrefix ?? (await import('./remux')).decryptPrefixToBuffer;
    const plain = await decrypt(input.fileKey, cipherPrefix);
    const entry: ContainerCacheEntry = {
      observation: observeContainerBytes(plain),
      expiresAt: Date.now() + CONTAINER_VERDICT_TTL_MS,
    };
    containerVerdictCache.set(key, entry);
    return entry;
  })();
  containerProbeInflight.set(key, run);
  try {
    const done = await run;
    return decideFor(done.observation, false);
  } finally {
    containerProbeInflight.delete(key);
  }
}
