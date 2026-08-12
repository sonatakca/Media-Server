/**
 * Provider match selection.
 *
 * Kept pure and separate from the HTTP client because this is where the real
 * risk lives: attaching the wrong TMDB record to a title silently rewrites its
 * name, artwork and overview, and the mistake is only visible to a human. The
 * scoring is deliberately conservative — a weak match is reported as low
 * confidence rather than applied.
 */

export interface MatchCandidate {
  providerId: string;
  title: string;
  originalTitle?: string;
  year?: number;
  popularity?: number;
}

export interface MatchInput {
  title: string;
  year?: number;
}

export interface MatchResult {
  candidate: MatchCandidate;
  score: number;
  confidence: "high" | "medium" | "low";
}

/**
 * Folds case, diacritics, punctuation and the common leading article so that
 * "The Lord of the Rings: The Two Towers" and "Lord of the Rings - The Two
 * Towers" compare equal.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/\s+/g, " ");
}

/**
 * Token-overlap similarity in [0, 1]. Chosen over edit distance because release
 * titles differ by whole words (subtitles, "Part Two", year suffixes) far more
 * often than by characters.
 */
export function titleSimilarity(left: string, right: string): number {
  const leftTokens = normalizeForMatch(left).split(" ").filter(Boolean);
  const rightTokens = normalizeForMatch(right).split(" ").filter(Boolean);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  if (leftTokens.join(" ") === rightTokens.join(" ")) return 1;

  const rightPool = [...rightTokens];
  let shared = 0;
  for (const token of leftTokens) {
    const index = rightPool.indexOf(token);
    if (index >= 0) {
      shared += 1;
      rightPool.splice(index, 1);
    }
  }

  // Penalise length mismatch so "Dune" does not score 1.0 against "Dune Part Two".
  return (2 * shared) / (leftTokens.length + rightTokens.length);
}

function yearScore(
  expected: number | undefined,
  actual: number | undefined,
): number {
  if (expected === undefined || actual === undefined) return 0;
  const distance = Math.abs(expected - actual);
  if (distance === 0) return 1;
  // A release year can legitimately differ by one between a country's cinema
  // release and the provider's primary date.
  if (distance === 1) return 0.6;
  if (distance === 2) return 0.2;
  return -0.5;
}

export function scoreCandidate(
  input: MatchInput,
  candidate: MatchCandidate,
): number {
  const titleScore = Math.max(
    titleSimilarity(input.title, candidate.title),
    candidate.originalTitle
      ? titleSimilarity(input.title, candidate.originalTitle)
      : 0,
  );

  // Popularity only breaks ties between comparable titles; it must never
  // outrank a better title or year match.
  const popularityBonus = Math.min(0.05, (candidate.popularity ?? 0) / 2_000);

  return (
    titleScore * 0.75 +
    yearScore(input.year, candidate.year) * 0.25 +
    popularityBonus
  );
}

export function selectBestMatch(
  input: MatchInput,
  candidates: MatchCandidate[],
): MatchResult | null {
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(input, candidate),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  if (!best) return null;

  const runnerUp = scored[1];
  const titleScore = Math.max(
    titleSimilarity(input.title, best.candidate.title),
    best.candidate.originalTitle
      ? titleSimilarity(input.title, best.candidate.originalTitle)
      : 0,
  );

  // A near-tie between two plausible records is the case that must not be
  // applied automatically, so indecisiveness caps confidence outright rather
  // than only blocking "high".
  const isDecisive = !runnerUp || best.score - runnerUp.score >= 0.1;

  let confidence: MatchResult["confidence"] = "low";
  if (isDecisive) {
    if (
      titleScore >= 0.95 &&
      (input.year === undefined || best.score >= 0.85)
    ) {
      confidence = "high";
    } else if (titleScore >= 0.7 && best.score >= 0.6) {
      confidence = "medium";
    }
  }

  return { candidate: best.candidate, score: best.score, confidence };
}
