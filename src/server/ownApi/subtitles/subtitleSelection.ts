/**
 * Judging what a provider offered.
 *
 * Two jobs, kept apart because they answer different questions. **Gates** decide
 * whether a candidate is the right subtitle at all — the same episode, the
 * language that was asked for, the forced status that was asked for. **Scores**
 * decide which of several right answers is best. A gate is never a weight: no
 * amount of release-group agreement makes a subtitle for the wrong episode
 * acceptable, because installing it looks exactly like the feature working.
 *
 * A rejected candidate says why. That is not decoration — when a search comes
 * back with forty results and installs none of them, "every candidate was for
 * the wrong season" and "every candidate was Turkish when English was wanted"
 * send an operator to completely different places, and a silent `null` sends
 * them nowhere.
 */

import { normalizeLanguage } from "../../../renditions/processing/languages";
import { parseRelease } from "../releases/parseRelease";
import type {
  ScoredCandidate,
  SubtitleCandidate,
  SubtitleProvider,
  SubtitleQuery,
} from "./subtitleProvider";
import {
  SCORE_DIMENSIONS,
  scoreOf,
  type ScoreDimension,
  type SubtitleWant,
} from "./subtitleState";

/**
 * A title reduced to what two spellings of it have in common.
 *
 * Providers punctuate differently from release names and from each other —
 * `Dune: Part Two`, `Dune Part Two`, `Dune - Part 2`. Comparing the letters and
 * digits alone matches those without matching two genuinely different films.
 * NFKC first, because a provider that writes `Ⅱ` and one that writes `II` mean
 * the same thing.
 */
function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Whether two release facts agree.
 *
 * Absent is never a match. Two candidates that both fail to state a release
 * group have not agreed about anything, and treating that as agreement would
 * give an unlabelled subtitle the same standing as a confirmed one. `unknown`
 * is the release parser's own word for absent and is treated the same way.
 */
function equalFact(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  if (left === "unknown" || right === "unknown") return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Whether two frame rates are the same rate.
 *
 * Providers round: `23.976`, `23.98` and `24000/1001` are one rate, while
 * `23.976` and `24` are not — the difference is a tenth of a percent, about
 * seven seconds over two hours, which is out of sync by the end.
 */
function sameFrameRate(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  if (!left || !right) return false;
  return Math.abs(left - right) < 0.01;
}

/**
 * What became of one candidate.
 *
 * A rejection carries a reason in words rather than a code, because its only
 * consumer is a person reading why a search found nothing.
 */
export type CandidateAssessment =
  | { readonly accepted: true; readonly scored: ScoredCandidate }
  | { readonly accepted: false; readonly reason: string };

const rejected = (reason: string): CandidateAssessment => ({
  accepted: false,
  reason,
});

/**
 * What each dimension means, said once, in words an operator reads.
 *
 * Never a provider's own text: a candidate's release title is untrusted input
 * and has no business in a message this system produces.
 */
const DIMENSION_DETAILS: Record<ScoreDimension, readonly [string, string]> = {
  identity: ["Not the same title.", "The same title, year and episode."],
  hashMatch: [
    "The provider did not match on the file itself.",
    "The provider matched on a hash of this exact file.",
  ],
  releaseGroup: [
    "A different release group, or neither says.",
    "The same release group.",
  ],
  frameRate: [
    "A different frame rate, or neither says.",
    "Timed for the same frame rate.",
  ],
  source: ["A different source, or neither says.", "The same source."],
  resolution: [
    "A different resolution, or neither says.",
    "The same resolution.",
  ],
  hearingImpaired: [
    "Not the hearing-impaired variant that was preferred.",
    "The hearing-impaired preference was met.",
  ],
  providerRank: [
    "From a provider this deployment does not rank.",
    "From a provider this deployment ranks.",
  ],
};

/** Identity, language and forced status are gates; release facts only rank matches. */
export function assessCandidate(
  query: SubtitleQuery,
  want: SubtitleWant,
  candidate: SubtitleCandidate,
  provider: SubtitleProvider,
): CandidateAssessment {
  const identity = candidate.identity;
  const language = normalizeLanguage(candidate.language);

  if (candidate.providerId !== provider.id) {
    return rejected("The candidate names a different provider than answered.");
  }
  if (!candidate.candidateId) {
    return rejected("The candidate has no id to download it by.");
  }
  if (language === "und") {
    return rejected("The candidate states no language.");
  }
  if (language !== want.language) {
    return rejected(
      `The candidate is ${language}, and ${want.language} was wanted.`,
    );
  }
  if (candidate.forced !== want.forced) {
    return rejected(
      want.forced
        ? "The candidate is a full subtitle, and a forced one was wanted."
        : "The candidate is a forced subtitle, and a full one was wanted.",
    );
  }
  /*
   * Absent evidence cannot win a search. A provider that returns a result
   * without saying what it is for is not offering a match, it is offering a
   * guess, and this system does not install guesses beside somebody's media.
   */
  if (!identity) {
    return rejected("The candidate says nothing about what it is for.");
  }
  if (titleKey(identity.title) !== titleKey(query.title)) {
    return rejected("The candidate is for a different title.");
  }
  if (identity.year !== query.year) {
    return rejected("The candidate is for a different year.");
  }
  if (identity.season !== query.season) {
    return rejected("The candidate is for a different season.");
  }
  if (identity.episode !== query.episode) {
    return rejected("The candidate is for a different episode.");
  }
  const facts = parseRelease(candidate.releaseTitle ?? "");
  const sourceFacts = parseRelease(query.releaseTitle ?? "");
  const matched: Record<ScoreDimension, boolean> = {
    identity: true,
    hashMatch: !!query.videoHash && candidate.hashMatched,
    releaseGroup: equalFact(
      query.releaseGroup ?? sourceFacts.releaseGroup,
      candidate.releaseGroup ?? facts.releaseGroup,
    ),
    frameRate: sameFrameRate(query.frameRate, candidate.frameRate),
    source: equalFact(
      query.source ?? sourceFacts.source,
      candidate.source ?? facts.source,
    ),
    resolution: equalFact(
      query.resolution ?? sourceFacts.resolution,
      candidate.resolution ?? facts.resolution,
    ),
    hearingImpaired:
      want.hearingImpaired !== "indifferent" &&
      candidate.hearingImpaired === (want.hearingImpaired === "prefer"),
    providerRank: provider.rank > 0,
  };
  const scored: ScoredCandidate = {
    candidate: { ...candidate, language },
    score: scoreOf(
      (Object.keys(SCORE_DIMENSIONS) as ScoreDimension[]).map((dimension) => ({
        dimension,
        weight: SCORE_DIMENSIONS[dimension],
        matched: matched[dimension],
        detail: DIMENSION_DETAILS[dimension][matched[dimension] ? 1 : 0],
      })),
    ),
  };
  return { accepted: true, scored };
}

/**
 * Best first, and stable.
 *
 * A provider's popularity figure breaks a tie first, then provider and candidate
 * id, so two runs of one search choose the same subtitle. An unstable order
 * there reads as a scoring bug and is not one.
 */
export function orderCandidates(
  candidates: readonly ScoredCandidate[],
): ScoredCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.score.total - a.score.total ||
      // Equal fit: the one more people downloaded has more often been right.
      (b.candidate.providerRating ?? 0) - (a.candidate.providerRating ?? 0) ||
      a.candidate.providerId.localeCompare(b.candidate.providerId) ||
      a.candidate.candidateId.localeCompare(b.candidate.candidateId),
  );
}
