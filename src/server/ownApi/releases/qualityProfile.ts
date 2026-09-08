/**
 * What the user wants, and whether a candidate satisfies it.
 *
 * Every answer carries its reasons. A decision engine that returns only a
 * number cannot answer the question an operator actually asks — "why did it
 * pick that one" — and the reasons are the part that survives into a UI.
 */
import {
  intrinsicRank,
  parseQualityId,
  qualityId,
  type Quality,
} from "./quality";

/**
 * One position in a profile's ordering.
 *
 * A position may hold several qualities, which is how the user's own `x265`
 * profiles are shaped: WEBDL-1080p, WEBRip-1080p and Bluray-1080p sit together
 * and are equally acceptable.
 */
export interface QualityProfileItem {
  readonly qualityIds: readonly string[];
  readonly allowed: boolean;
}

export interface QualityProfile {
  readonly id: string;
  readonly name: string;
  /** Worst first, so a later index is a better quality. */
  readonly items: readonly QualityProfileItem[];
  /** Nothing better than this is sought. A quality id. */
  readonly cutoffQualityId: string;
  /**
   * Whether a better release may replace one already held.
   *
   * Every profile in the library this replaces has this off, so it defaults
   * off: an upgrade is a second download and a second import of something the
   * user already has.
   */
  readonly upgradeAllowed: boolean;
  /** A candidate scoring below this is refused however good its quality. */
  readonly minFormatScore: number;
  /** Below this, the cutoff is not considered met even at cutoff quality. */
  readonly cutoffFormatScore: number;
}

export type QualityReasonCode =
  | "quality-allowed"
  | "quality-not-allowed"
  | "quality-unknown"
  | "below-format-score"
  | "cutoff-met"
  | "cutoff-not-met";

export interface Reason {
  readonly code: string;
  readonly detail: string;
}

export interface QualityVerdict {
  readonly quality: Quality;
  readonly allowed: boolean;
  /** Position in the profile's ordering; null when the profile has no place for it. */
  readonly rank: number | null;
  readonly meetsCutoff: boolean;
  readonly reasons: readonly Reason[];
}

function rankOf(profile: QualityProfile, id: string): number | null {
  for (let index = 0; index < profile.items.length; index += 1) {
    const item = profile.items[index]!;
    if (item.qualityIds.includes(id)) return item.allowed ? index : null;
  }
  return null;
}

/** The rank of the cutoff, or the top of the profile if it names an unknown one. */
export function cutoffRank(profile: QualityProfile): number {
  const rank = rankOf(profile, profile.cutoffQualityId);
  return rank ?? profile.items.length - 1;
}

export function evaluateQuality(
  quality: Quality,
  profile: QualityProfile,
  formatScore = 0,
): QualityVerdict {
  const id = qualityId(quality);
  const reasons: Reason[] = [];
  const rank = rankOf(profile, id);

  if (rank === null) {
    reasons.push({
      code:
        quality.source === "unknown"
          ? "quality-unknown"
          : "quality-not-allowed",
      detail:
        quality.source === "unknown"
          ? "The release does not say what it is."
          : `${id} is not allowed by ${profile.name}.`,
    });
    return { quality, allowed: false, rank: null, meetsCutoff: false, reasons };
  }

  reasons.push({
    code: "quality-allowed",
    detail: `${id} is allowed by ${profile.name}.`,
  });

  if (formatScore < profile.minFormatScore) {
    reasons.push({
      code: "below-format-score",
      detail: `Scored ${formatScore}, below the minimum ${profile.minFormatScore}.`,
    });
    return { quality, allowed: false, rank, meetsCutoff: false, reasons };
  }

  const meetsCutoff =
    rank >= cutoffRank(profile) && formatScore >= profile.cutoffFormatScore;
  reasons.push(
    meetsCutoff
      ? {
          code: "cutoff-met",
          detail: `At or above the cutoff (${profile.cutoffQualityId}).`,
        }
      : {
          code: "cutoff-not-met",
          detail: `Below the cutoff (${profile.cutoffQualityId}).`,
        },
  );

  return { quality, allowed: true, rank, meetsCutoff, reasons };
}

export type UpgradeReasonCode =
  | "no-current-release"
  | "upgrades-disabled"
  | "cutoff-already-met"
  | "not-an-upgrade"
  | "is-an-upgrade";

export interface UpgradeVerdict {
  readonly wanted: boolean;
  readonly reasons: readonly Reason[];
}

/**
 * Whether a candidate should replace what is already held.
 *
 * Ordered so the cheapest refusals come first, and so that each returns the one
 * reason that actually decided it rather than a list the caller has to rank.
 */
export function evaluateUpgrade(
  candidate: QualityVerdict,
  current: { readonly quality: Quality; readonly formatScore: number } | null,
  profile: QualityProfile,
  candidateFormatScore = 0,
): UpgradeVerdict {
  if (!current) {
    return {
      wanted: candidate.allowed,
      reasons: [
        {
          code: "no-current-release",
          detail:
            "Nothing is held, so this would not be an upgrade but an acquisition.",
        },
      ],
    };
  }
  if (!candidate.allowed) {
    return { wanted: false, reasons: candidate.reasons };
  }
  if (!profile.upgradeAllowed) {
    return {
      wanted: false,
      reasons: [
        {
          code: "upgrades-disabled",
          detail: `${profile.name} does not allow upgrades.`,
        },
      ],
    };
  }

  const currentVerdict = evaluateQuality(
    current.quality,
    profile,
    current.formatScore,
  );
  if (currentVerdict.meetsCutoff) {
    return {
      wanted: false,
      reasons: [
        {
          code: "cutoff-already-met",
          detail: "What is held already satisfies the cutoff.",
        },
      ],
    };
  }

  const currentRank = currentVerdict.rank ?? -1;
  const better =
    candidate.rank! > currentRank ||
    (candidate.rank === currentRank &&
      candidateFormatScore > current.formatScore);
  return {
    wanted: better,
    reasons: [
      better
        ? {
            code: "is-an-upgrade",
            detail: `Ranks above what is held (${qualityId(current.quality)}).`,
          }
        : {
            code: "not-an-upgrade",
            detail: `Does not rank above what is held (${qualityId(current.quality)}).`,
          },
    ],
  };
}

/** Builds a profile from quality ids listed worst first. */
export function profileFromIds(
  id: string,
  name: string,
  orderedQualityIds: readonly (string | readonly string[])[],
  options: {
    cutoffQualityId?: string;
    upgradeAllowed?: boolean;
    minFormatScore?: number;
    cutoffFormatScore?: number;
  } = {},
): QualityProfile {
  const items = orderedQualityIds.map((entry) => ({
    qualityIds: (typeof entry === "string" ? [entry] : entry).filter(
      (value) => parseQualityId(value) !== undefined,
    ),
    allowed: true,
  }));
  const last = items[items.length - 1];
  return {
    id,
    name,
    items,
    cutoffQualityId: options.cutoffQualityId ?? last?.qualityIds[0] ?? "",
    upgradeAllowed: options.upgradeAllowed ?? false,
    minFormatScore: options.minFormatScore ?? 0,
    cutoffFormatScore: options.cutoffFormatScore ?? 0,
  };
}

/** Orders two allowed candidates of equal profile rank. Never returns 0 for
 * different qualities, so ranking cannot fall through to input order. */
export function breakQualityTie(left: Quality, right: Quality): number {
  return intrinsicRank(right) - intrinsicRank(left);
}
