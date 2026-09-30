import { bitErrors, FINGERPRINT_SECONDS_PER_WORD } from "./audioFingerprint";

/** Where the same audio sits in two fingerprints, in word indices, end exclusive. */
export interface SharedRegion {
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
}

export interface SharedRegionOptions {
  /** Shortest run worth reporting, in seconds. */
  minimumSeconds: number;
  /** Longest run that can be the kind of segment being looked for. */
  maximumSeconds: number;
}

/**
 * Mean differing bits, over a smoothing window, below which two stretches of
 * audio count as the same. Unrelated audio differs in about 16 of 32; the
 * same theme through two different encodes, in 3 to 8.
 */
const MATCH_BIT_ERRORS = 10;
/** Smoothing window: long enough to ride over a transient. */
const WINDOW_WORDS = Math.round(1.4 / FINGERPRINT_SECONDS_PER_WORD);
/** A dip this long inside a match does not end it: a line of dialogue over the music. */
const GAP_TOLERANCE_WORDS = Math.round(1 / FINGERPRINT_SECONDS_PER_WORD);
/** A key seen more often than this is silence or a drone, and votes for nothing. */
const COMMON_KEY_LIMIT = 48;
const CANDIDATE_OFFSETS = 8;
const MINIMUM_VOTES = 6;

/**
 * The 16-bit pieces of a word that vote for alignments.
 *
 * A whole 32-bit word rarely survives a re-encode bit for bit — measured, one
 * in several hundred — while a given 16 bits of it do about one time in fifty.
 * Three overlapping pieces, each tagged with its position so they cannot
 * collide, give every word three chances to vote.
 */
function voteKeys(word: number): [number, number, number] {
  return [
    word & 0xffff,
    0x10000 | ((word >>> 8) & 0xffff),
    0x20000 | ((word >>> 16) & 0xffff),
  ];
}

/**
 * The longest stretch of audio two fingerprints share, or null.
 *
 * Offsets are proposed by pieces of words that match exactly — the pieces
 * that survive a re-encode all agree on how far one copy is shifted against
 * the other — and each proposal is then checked frame by frame with a
 * tolerant comparison, which is what decides where the shared part begins and
 * ends.
 */
export function findSharedRegion(
  left: Uint32Array,
  right: Uint32Array,
  { minimumSeconds, maximumSeconds }: SharedRegionOptions,
): SharedRegion | null {
  if (left.length === 0 || right.length === 0) return null;

  const positions = new Map<number, number[]>();
  for (let index = 0; index < right.length; index += 1) {
    for (const key of voteKeys(right[index]!)) {
      const list = positions.get(key);
      if (list) list.push(index);
      else positions.set(key, [index]);
    }
  }

  const votes = new Map<number, number>();
  for (let index = 0; index < left.length; index += 1) {
    for (const key of voteKeys(left[index]!)) {
      const matches = positions.get(key);
      if (!matches || matches.length > COMMON_KEY_LIMIT) continue;
      for (const match of matches) {
        const offset = match - index;
        votes.set(offset, (votes.get(offset) ?? 0) + 1);
      }
    }
  }

  // Neighbouring offsets are the same alignment seen through timing jitter.
  const smoothed = [...votes.keys()].map((offset) => ({
    offset,
    votes:
      (votes.get(offset - 1) ?? 0) +
      (votes.get(offset) ?? 0) +
      (votes.get(offset + 1) ?? 0),
  }));
  smoothed.sort((a, b) => b.votes - a.votes);

  const tried = new Set<number>();
  let best: SharedRegion | null = null;
  const minimumWords = Math.ceil(minimumSeconds / FINGERPRINT_SECONDS_PER_WORD);
  const maximumWords = Math.floor(
    maximumSeconds / FINGERPRINT_SECONDS_PER_WORD,
  );

  for (const candidate of smoothed) {
    if (tried.size >= CANDIDATE_OFFSETS) break;
    if (candidate.votes < MINIMUM_VOTES) break;
    if (
      tried.has(candidate.offset) ||
      tried.has(candidate.offset - 1) ||
      tried.has(candidate.offset + 1)
    )
      continue;
    tried.add(candidate.offset);

    const region = longestMatchingRun(left, right, candidate.offset);
    if (!region) continue;
    const length = region.leftEnd - region.leftStart;
    if (length < minimumWords || length > maximumWords) continue;
    if (!best || length > best.leftEnd - best.leftStart) best = region;
  }
  return best;
}

/** Along one alignment, the longest run whose smoothed bit errors stay low. */
function longestMatchingRun(
  left: Uint32Array,
  right: Uint32Array,
  offset: number,
): SharedRegion | null {
  const start = Math.max(0, -offset);
  const end = Math.min(left.length, right.length - offset);
  const length = end - start;
  if (length <= WINDOW_WORDS) return null;

  const errors = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    errors[index] = bitErrors(
      left[start + index]!,
      right[start + index + offset]!,
    );
  }

  // Centred moving average, so a match is judged on its surroundings.
  const good = new Uint8Array(length);
  let sum = 0;
  const half = Math.floor(WINDOW_WORDS / 2);
  for (let index = 0; index < Math.min(length, half); index += 1) {
    sum += errors[index]!;
  }
  for (let index = 0; index < length; index += 1) {
    const enter = index + half;
    const leave = index - half - 1;
    if (enter < length) sum += errors[enter]!;
    if (leave >= 0) sum -= errors[leave]!;
    const count = Math.min(length, enter + 1) - Math.max(0, leave + 1);
    good[index] = sum / count <= MATCH_BIT_ERRORS ? 1 : 0;
  }

  let bestStart = -1;
  let bestEnd = -1;
  let runStart = -1;
  let lastGood = -1;
  for (let index = 0; index <= length; index += 1) {
    const isGood = index < length && good[index] === 1;
    if (isGood) {
      if (runStart < 0 || index - lastGood > GAP_TOLERANCE_WORDS) {
        runStart = index;
      }
      lastGood = index;
      if (lastGood + 1 - runStart > bestEnd - bestStart) {
        bestStart = runStart;
        bestEnd = lastGood + 1;
      }
    }
  }
  if (bestStart < 0) return null;
  return {
    leftStart: start + bestStart,
    leftEnd: start + bestEnd,
    rightStart: start + bestStart + offset,
    rightEnd: start + bestEnd + offset,
  };
}
