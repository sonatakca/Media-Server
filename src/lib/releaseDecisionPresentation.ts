/**
 * Putting a set of judged releases in the order a person reads them.
 *
 * The decision engine returns every candidate with a verdict; the ordering is
 * this module's job, and it is deliberately not "by score". A rejected release
 * can score well on the preferences it did match, so sorting by score alone
 * would put something the server refuses to download above something it would.
 */

export interface JudgedRelease {
  readonly guid: string;
  readonly indexerId: string;
  readonly title: string;
  readonly quality: string;
  readonly accepted: boolean;
  readonly rank: number | null;
  readonly score: number;
  readonly rejection?: string;
  readonly reasons: ReadonlyArray<{ code: string; detail: string }>;
  readonly sizeBytes?: number;
  readonly publishedAt?: string;
}

export interface OrderedRelease extends JudgedRelease {
  /** The one the server would take. Exactly zero or one in a set. */
  readonly isWinner: boolean;
}

/**
 * Accepted first, then by quality rank, then by preference score.
 *
 * Rank before score because rank is what the profile allows and score is only
 * how much it is liked: a 1080p release that scores highly must not appear
 * above a 2160p one when the profile prefers 2160p. Ties fall back to the
 * title, so the same set always reads in the same order.
 */
export function orderCandidates(
  candidates: readonly JudgedRelease[],
  winnerGuid: string | null,
): OrderedRelease[] {
  return [...candidates]
    .map((candidate) => ({
      ...candidate,
      isWinner: winnerGuid !== null && candidate.guid === winnerGuid,
    }))
    .sort((a, b) => {
      if (a.isWinner !== b.isWinner) return a.isWinner ? -1 : 1;
      if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
      // A null rank is "no rank at all", which sorts below every real one.
      const rankA = a.rank ?? Number.NEGATIVE_INFINITY;
      const rankB = b.rank ?? Number.NEGATIVE_INFINITY;
      if (rankA !== rankB) return rankB - rankA;
      if (a.score !== b.score) return b.score - a.score;
      return a.title.localeCompare(b.title);
    });
}

/** How many were judged, and how many the profile would allow. */
export function summarise(candidates: readonly JudgedRelease[]): {
  total: number;
  accepted: number;
  rejected: number;
} {
  const accepted = candidates.filter((candidate) => candidate.accepted).length;
  return {
    total: candidates.length,
    accepted,
    rejected: candidates.length - accepted,
  };
}

/**
 * Whether a release can be asked for.
 *
 * Only an accepted one. Offering to download something the profile rejects
 * would put the operator and the decision engine in disagreement, and the
 * server would refuse it anyway — the release is identified by indexer and
 * guid, and resolution happens there.
 */
export function canAcquire(candidate: JudgedRelease): boolean {
  return candidate.accepted;
}
