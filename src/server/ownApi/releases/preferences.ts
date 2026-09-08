/**
 * Preferences: the things a person likes that quality alone cannot express.
 *
 * The library this replaces uses exactly one of these today — "x265 HEVC",
 * worth 100 in two profiles and 0 in the rest — so the model is built around
 * being able to say that plainly, and to grow, rather than around reproducing
 * every knob the applications it replaces happen to expose.
 *
 * **There is deliberately no regular expression here.** User-supplied patterns
 * are the usual way a scoring engine acquires a denial-of-service hole: a rule
 * saved once runs against every candidate of every future search, and a
 * catastrophically backtracking pattern would stall the process. Matching is
 * by enumerated fact or by plain case-insensitive substring, which cannot
 * backtrack at all. That is a refusal, not an oversight — mitigating ReDoS
 * with timeouts would still leave the engine executing a stranger's program.
 */
import type {
  AudioCodec,
  HdrFormat,
  ReleaseFacts,
  Resolution,
  VideoCodec,
} from "./releaseFacts";
import { qualityOf, type QualitySource } from "./quality";
import type { Reason } from "./qualityProfile";

export type ReleaseFlag =
  | "proper"
  | "repack"
  | "real"
  | "internal"
  | "seasonPack";

export type PreferenceCondition =
  | { readonly type: "videoCodec"; readonly values: readonly VideoCodec[] }
  | { readonly type: "source"; readonly values: readonly QualitySource[] }
  | { readonly type: "resolution"; readonly values: readonly Resolution[] }
  | { readonly type: "hdr"; readonly values: readonly HdrFormat[] }
  | { readonly type: "audioCodec"; readonly values: readonly AudioCodec[] }
  | { readonly type: "audioFeature"; readonly values: readonly string[] }
  | { readonly type: "edition"; readonly values: readonly string[] }
  | { readonly type: "language"; readonly values: readonly string[] }
  | { readonly type: "releaseGroup"; readonly values: readonly string[] }
  | { readonly type: "streamingService"; readonly values: readonly string[] }
  | { readonly type: "flag"; readonly values: readonly ReleaseFlag[] }
  /** Plain substring, case-insensitive. Never a pattern. */
  | { readonly type: "titleContains"; readonly values: readonly string[] };

export interface PreferenceRule {
  readonly id: string;
  readonly name: string;
  /** Added when the rule matches. Negative to discourage. */
  readonly score: number;
  /** Every condition must hold. An empty list never matches. */
  readonly conditions: readonly PreferenceCondition[];
  /** Match when the conditions do *not* hold — "anything but this group". */
  readonly negate?: boolean;
}

export interface ScoreContribution {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly matched: boolean;
  /** Zero unless the rule matched, so the trail shows what was considered. */
  readonly score: number;
  readonly reason: string;
}

export interface PreferenceScore {
  readonly total: number;
  readonly contributions: readonly ScoreContribution[];
}

const lower = (values: readonly string[]) =>
  values.map((value) => value.toLowerCase());

function conditionHolds(
  condition: PreferenceCondition,
  facts: ReleaseFacts,
): boolean {
  switch (condition.type) {
    case "videoCodec":
      return condition.values.includes(facts.videoCodec);
    case "source":
      return condition.values.includes(qualityOf(facts).source);
    case "resolution":
      return condition.values.includes(facts.resolution);
    case "hdr":
      return facts.hdr.some((value) => condition.values.includes(value));
    case "audioCodec":
      return condition.values.includes(facts.audioCodec);
    case "audioFeature":
      return facts.audioFeatures.some((value) =>
        lower(condition.values).includes(value.toLowerCase()),
      );
    case "edition":
      return facts.edition.some((value) =>
        lower(condition.values).includes(value.toLowerCase()),
      );
    case "language":
      return facts.languages.some((value) =>
        lower(condition.values).includes(value.toLowerCase()),
      );
    case "releaseGroup":
      return (
        facts.releaseGroup !== undefined &&
        lower(condition.values).includes(facts.releaseGroup.toLowerCase())
      );
    case "streamingService":
      return (
        facts.streamingService !== undefined &&
        lower(condition.values).includes(facts.streamingService.toLowerCase())
      );
    case "flag":
      return condition.values.some((flag) =>
        flag === "seasonPack" ? facts.isSeasonPack : facts[flag],
      );
    case "titleContains": {
      const title = facts.rawTitle.toLowerCase();
      return lower(condition.values).some(
        (value) => value !== "" && title.includes(value),
      );
    }
    default:
      return false;
  }
}

export function ruleMatches(
  rule: PreferenceRule,
  facts: ReleaseFacts,
): boolean {
  // An empty rule matches nothing, negated or not: a rule with no conditions
  // is a mistake, and making it match everything would score every candidate.
  if (rule.conditions.length === 0) return false;
  const holds = rule.conditions.every((condition) =>
    conditionHolds(condition, facts),
  );
  return rule.negate === true ? !holds : holds;
}

/**
 * Scores a release, keeping every rule that was considered.
 *
 * Rules that did not match are reported with a zero contribution rather than
 * omitted, so a person looking at a decision can see the rule was evaluated
 * and did not apply — which is a different thing from the rule not existing.
 */
export function scoreRelease(
  facts: ReleaseFacts,
  rules: readonly PreferenceRule[],
): PreferenceScore {
  const contributions: ScoreContribution[] = [];
  let total = 0;
  for (const rule of rules) {
    const matched = ruleMatches(rule, facts);
    if (matched) total += rule.score;
    contributions.push({
      ruleId: rule.id,
      ruleName: rule.name,
      matched,
      score: matched ? rule.score : 0,
      reason: matched
        ? `${rule.name} ${rule.score >= 0 ? "+" : ""}${rule.score}`
        : `${rule.name} did not apply`,
    });
  }
  return { total, contributions };
}

/** The matched contributions, as reasons for a decision trail. */
export function scoreReasons(score: PreferenceScore): Reason[] {
  return score.contributions
    .filter((contribution) => contribution.matched)
    .map((contribution) => ({
      code: `preference:${contribution.ruleId}`,
      detail: contribution.reason,
    }));
}

/**
 * The one rule the existing library actually uses.
 *
 * Kept here as a named constant rather than seeded into the database, so the
 * migration that carries the user's policy over has something to point at.
 */
export const HEVC_PREFERENCE: PreferenceRule = {
  id: "x265-hevc",
  name: "x265 HEVC",
  score: 100,
  conditions: [{ type: "videoCodec", values: ["hevc"] }],
};
