/**
 * What Seyirlik is watching for, and what it therefore wants.
 *
 * Movies and series share this vocabulary rather than getting one module each.
 * The question "is this monitored, against which profile, and is what we hold
 * good enough" is the same question for both; only the shape of the thing being
 * monitored differs, and that difference is one field.
 */
import { parseQualityId, type Quality } from "./quality";
import {
  evaluateQuality,
  type QualityProfile,
  type Reason,
} from "./qualityProfile";

/**
 * A season's or episode's own opinion about being monitored.
 *
 * `inherit` is the point of the type. Three independent booleans cannot record
 * whether an unmonitored season was chosen or merely inherited, so the
 * precedence would live in whichever code happened to read it.
 */
export type MonitoringChoice = "inherit" | "monitored" | "unmonitored";

export interface MonitoredItem {
  readonly itemId: string;
  readonly monitored: boolean;
  readonly profileId?: string;
  /** Null when nothing is held — different from holding something unreadable. */
  readonly currentQualityId?: string;
  readonly currentFormatScore: number;
}

export interface MonitoredSeason {
  readonly seasonNumber: number;
  readonly monitoring: MonitoringChoice;
}

export interface MonitoredEpisode {
  readonly seasonNumber: number;
  readonly episodeNumber: number;
  readonly monitoring: MonitoringChoice;
  /** Undefined means unknown, not "not yet aired". */
  readonly airedAtMs?: number;
  readonly currentQualityId?: string;
  readonly currentFormatScore: number;
}

export interface MonitoringDecision {
  readonly monitored: boolean;
  /** Which level actually decided it. */
  readonly decidedBy: "series" | "season" | "episode";
  readonly reason: Reason;
}

/**
 * Whether an episode is monitored, and which level said so.
 *
 * Walks up from the most specific opinion. The first level with an opinion
 * wins, which is why an episode may be monitored inside an unmonitored season
 * inside a monitored series without any of the three contradicting each other.
 */
export function resolveEpisodeMonitoring(
  series: Pick<MonitoredItem, "monitored">,
  season: MonitoredSeason | undefined,
  episode: Pick<MonitoredEpisode, "monitoring"> | undefined,
): MonitoringDecision {
  if (episode && episode.monitoring !== "inherit") {
    const monitored = episode.monitoring === "monitored";
    return {
      monitored,
      decidedBy: "episode",
      reason: {
        code: monitored ? "episode-monitored" : "episode-unmonitored",
        detail: "The episode has its own setting.",
      },
    };
  }
  if (season && season.monitoring !== "inherit") {
    const monitored = season.monitoring === "monitored";
    return {
      monitored,
      decidedBy: "season",
      reason: {
        code: monitored ? "season-monitored" : "season-unmonitored",
        detail: `Season ${season.seasonNumber} has its own setting.`,
      },
    };
  }
  return {
    monitored: series.monitored,
    decidedBy: "series",
    reason: {
      code: series.monitored ? "series-monitored" : "series-unmonitored",
      detail: "Inherited from the series.",
    },
  };
}

export function resolveSeasonMonitoring(
  series: Pick<MonitoredItem, "monitored">,
  season: MonitoredSeason | undefined,
): MonitoringDecision {
  if (season && season.monitoring !== "inherit") {
    const monitored = season.monitoring === "monitored";
    return {
      monitored,
      decidedBy: "season",
      reason: {
        code: monitored ? "season-monitored" : "season-unmonitored",
        detail: `Season ${season.seasonNumber} has its own setting.`,
      },
    };
  }
  return {
    monitored: series.monitored,
    decidedBy: "series",
    reason: {
      code: series.monitored ? "series-monitored" : "series-unmonitored",
      detail: "Inherited from the series.",
    },
  };
}

export type WantReason =
  | "not-monitored"
  | "no-profile"
  | "not-yet-aired"
  | "missing"
  | "below-cutoff"
  | "satisfied";

export interface WantedVerdict {
  readonly wanted: boolean;
  readonly reason: WantReason;
  readonly detail: string;
  /** What is held, when it is held and readable. */
  readonly current?: Quality;
}

function heldQuality(qualityId: string | undefined): Quality | undefined {
  return qualityId === undefined ? undefined : parseQualityId(qualityId);
}

/**
 * Whether Seyirlik wants something for this target, and why.
 *
 * Deliberately answers only "why do we want it" — not "go and get it".
 * Acquisition is a later phase, and a want that has already started a download
 * is a different record with a different lifetime.
 */
export function evaluateWanted(
  input: {
    readonly monitored: boolean;
    readonly currentQualityId?: string;
    readonly currentFormatScore?: number;
    /** Undefined means unknown; a future date means it cannot be missing yet. */
    readonly airedAtMs?: number;
  },
  profile: QualityProfile | undefined,
  now: number = Date.now(),
): WantedVerdict {
  if (!input.monitored) {
    return {
      wanted: false,
      reason: "not-monitored",
      detail: "Not monitored.",
    };
  }
  if (!profile) {
    return {
      wanted: false,
      reason: "no-profile",
      detail: "No quality profile is assigned, so nothing can be judged.",
    };
  }
  if (input.airedAtMs !== undefined && input.airedAtMs > now) {
    // Not missing: it does not exist yet. Reporting it as missing would put
    // every future episode of every monitored series into the wanted list.
    return {
      wanted: false,
      reason: "not-yet-aired",
      detail: "Has not aired yet.",
    };
  }

  const current = heldQuality(input.currentQualityId);
  if (!current) {
    return { wanted: true, reason: "missing", detail: "Nothing is held." };
  }

  const score = input.currentFormatScore ?? 0;
  const verdict = evaluateQuality(current, profile, score);
  if (verdict.meetsCutoff) {
    return {
      wanted: false,
      reason: "satisfied",
      detail: "What is held meets the cutoff.",
      current,
    };
  }

  /*
   * Below the cutoff. Whether that is worth acting on is the profile's call,
   * and nothing else: there is no candidate here to compare against yet, so
   * asking the upgrade rules would be comparing what is held with itself.
   */
  return profile.upgradeAllowed
    ? {
        wanted: true,
        reason: "below-cutoff",
        detail: "What is held is below the cutoff and upgrades are allowed.",
        current,
      }
    : {
        wanted: false,
        reason: "satisfied",
        detail:
          "What is held is below the cutoff, but this profile does not upgrade.",
        current,
      };
}
