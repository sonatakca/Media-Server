/**
 * Which release would be acquired, and why every other one would not.
 *
 * Deterministic by construction. The same candidates, profile, preferences and
 * held state always produce the same winner, and the ladder that breaks a tie
 * ends in a stable identifier so provider ordering can never decide it. That
 * matters more than it sounds: an indexer returns results in whatever order it
 * likes, and a comparison that returns 0 for two genuinely different releases
 * silently hands the choice to that order.
 *
 * Nothing here acquires anything. It names a winner; a later phase decides
 * what to do about it.
 */
import type { IndexerRelease } from "../indexers/indexerTypes";
import { parseRelease } from "./parseRelease";
import { qualityOf, type Quality } from "./quality";
import {
  breakQualityTie,
  evaluateQuality,
  evaluateUpgrade,
  type QualityProfile,
  type Reason,
} from "./qualityProfile";
import { scoreRelease, scoreReasons, type PreferenceRule } from "./preferences";
import type { ReleaseFacts } from "./releaseFacts";

export type MediaTarget =
  | { readonly kind: "movie"; readonly title: string; readonly year?: number }
  | {
      readonly kind: "episode";
      readonly title: string;
      readonly season: number;
      readonly episode: number;
    }
  | {
      readonly kind: "season";
      readonly title: string;
      readonly season: number;
    };

export type RejectionCode =
  | "title-mismatch"
  | "wrong-year"
  | "wrong-season"
  | "wrong-episode"
  | "wrong-kind"
  | "quality-not-allowed"
  | "quality-unknown"
  | "below-format-score"
  | "upgrade-not-wanted";

export interface CandidateDecision {
  readonly release: IndexerRelease;
  readonly facts: ReleaseFacts;
  readonly quality: Quality;
  readonly accepted: boolean;
  readonly rank: number | null;
  readonly score: number;
  readonly rejection?: RejectionCode;
  readonly reasons: readonly Reason[];
}

export interface SelectionResult {
  readonly target: MediaTarget;
  /** Every candidate, accepted first then rejected — none silently dropped. */
  readonly candidates: readonly CandidateDecision[];
  readonly winner?: CandidateDecision;
}

export interface DecisionPolicy {
  readonly profile: QualityProfile;
  readonly preferences: readonly PreferenceRule[];
  /** What is already held for this target, if anything. */
  readonly current?: {
    readonly quality: Quality;
    readonly formatScore: number;
  } | null;
}

/** Punctuation and articles removed, so "The Expanse" matches "Expanse". */
function comparableTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(?:the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatch(candidate: string, wanted: string): boolean {
  const left = comparableTitle(candidate);
  const right = comparableTitle(wanted);
  if (left === "" || right === "") return false;
  return (
    left === right ||
    left.startsWith(`${right} `) ||
    right.startsWith(`${left} `)
  );
}

/**
 * Whether the release is of the thing that was asked for.
 *
 * A year may differ by one: a film released in December is routinely tagged
 * with the following year by one indexer and the previous by another. Two
 * years apart is a different film.
 */
function matchTarget(
  facts: ReleaseFacts,
  target: MediaTarget,
): { ok: true } | { ok: false; code: RejectionCode; detail: string } {
  if (!titlesMatch(facts.normalizedTitle, target.title)) {
    return {
      ok: false,
      code: "title-mismatch",
      detail: `Reads as "${facts.normalizedTitle}", not "${target.title}".`,
    };
  }

  if (target.kind === "movie") {
    if (facts.kind === "episode" || facts.kind === "season") {
      return {
        ok: false,
        code: "wrong-kind",
        detail: "This is a television release.",
      };
    }
    if (target.year !== undefined && facts.year !== undefined) {
      const drift = Math.abs(facts.year - target.year);
      if (drift > 1) {
        return {
          ok: false,
          code: "wrong-year",
          detail: `Dated ${facts.year}, not ${target.year}.`,
        };
      }
    }
    return { ok: true };
  }

  const range = facts.episodeRanges.find(
    (entry) => entry.season === target.season,
  );
  if (!range) {
    return {
      ok: false,
      code: "wrong-season",
      detail:
        facts.episodeRanges.length === 0
          ? "Names no season."
          : `Covers season ${facts.episodeRanges.map((r) => r.season).join(", ")}, not ${target.season}.`,
    };
  }

  if (target.kind === "season") {
    // A pack satisfies a season; a single episode does not.
    return range.episodes.length === 0
      ? { ok: true }
      : {
          ok: false,
          code: "wrong-kind",
          detail: "This is an episode, not a season.",
        };
  }

  // A whole-season pack contains the episode; otherwise it must be listed.
  if (range.episodes.length === 0 || range.episodes.includes(target.episode)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: "wrong-episode",
    detail: `Covers episode ${range.episodes.join(", ")}, not ${target.episode}.`,
  };
}

function judge(
  release: IndexerRelease,
  target: MediaTarget,
  policy: DecisionPolicy,
): CandidateDecision {
  const facts = parseRelease(release.title);
  const quality = qualityOf(facts);
  const score = scoreRelease(facts, policy.preferences);

  const match = matchTarget(facts, target);
  if (!match.ok) {
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: null,
      score: score.total,
      rejection: match.code,
      reasons: [{ code: match.code, detail: match.detail }],
    };
  }

  const verdict = evaluateQuality(quality, policy.profile, score.total);
  const reasons: Reason[] = [...verdict.reasons, ...scoreReasons(score)];
  if (!verdict.allowed) {
    const rejection = verdict.reasons.find((reason) =>
      ["quality-not-allowed", "quality-unknown", "below-format-score"].includes(
        reason.code,
      ),
    );
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: verdict.rank,
      score: score.total,
      rejection: (rejection?.code ?? "quality-not-allowed") as RejectionCode,
      reasons,
    };
  }

  const upgrade = evaluateUpgrade(
    verdict,
    policy.current ?? null,
    policy.profile,
    score.total,
  );
  if (!upgrade.wanted) {
    return {
      release,
      facts,
      quality,
      accepted: false,
      rank: verdict.rank,
      score: score.total,
      rejection: "upgrade-not-wanted",
      reasons: [...reasons, ...upgrade.reasons],
    };
  }

  return {
    release,
    facts,
    quality,
    accepted: true,
    rank: verdict.rank,
    score: score.total,
    reasons: [...reasons, ...upgrade.reasons],
  };
}

/**
 * The order two accepted candidates are preferred in.
 *
 * Each rung is a claim that can be defended on its own:
 *
 * 1. profile rank — the user said which quality they want
 * 2. preference score — then what they said they like
 * 3. revision — a PROPER exists because the first attempt was broken
 * 4. intrinsic quality — separates qualities the profile grouped together
 * 5. size — at identical quality, more bits is less compression
 * 6. identifier — so the answer is stable when nothing else distinguishes them
 *
 * Never returns 0 for two different releases, which is the point: a zero here
 * would let the provider's response order pick the winner.
 */
export function compareCandidates(
  left: CandidateDecision,
  right: CandidateDecision,
): number {
  if (left.accepted !== right.accepted) return left.accepted ? -1 : 1;
  const byRank = (right.rank ?? -1) - (left.rank ?? -1);
  if (byRank !== 0) return byRank;
  const byScore = right.score - left.score;
  if (byScore !== 0) return byScore;
  const byRevision = right.facts.revision - left.facts.revision;
  if (byRevision !== 0) return byRevision;
  const byQuality = breakQualityTie(left.quality, right.quality);
  if (byQuality !== 0) return byQuality;
  const bySize = (right.release.sizeBytes ?? 0) - (left.release.sizeBytes ?? 0);
  if (bySize !== 0) return bySize;
  if (left.release.guid === right.release.guid) return 0;
  return left.release.guid < right.release.guid ? -1 : 1;
}

export function selectRelease(
  target: MediaTarget,
  candidates: readonly IndexerRelease[],
  policy: DecisionPolicy,
): SelectionResult {
  const decided = candidates.map((release) => judge(release, target, policy));
  const ordered = [...decided].sort(compareCandidates);
  const winner = ordered.find((candidate) => candidate.accepted);
  return {
    target,
    candidates: ordered,
    ...(winner === undefined ? {} : { winner }),
  };
}
