import type {
  ProcessingEpisode,
  ProcessingSeason,
  ProcessingSeries,
  ProcessingStateCounts,
} from "../../lib/processingApi";

/**
 * The television view's own logic, kept out of the component.
 *
 * Searching, expanding and summarising are the parts of this screen that have
 * rules worth stating and worth testing; rendering them is not. Keeping them
 * here also keeps them pure, which is what lets the page poll once a second
 * without a filter resetting or a season closing under the operator's hand.
 */

/** A search that matches a show, a season, an episode title, or `S01E01`. */
export function matchesQuery(
  series: ProcessingSeries,
  season: ProcessingSeason,
  episode: ProcessingEpisode,
  query: string,
): boolean {
  if (!query) return true;
  const haystack = [
    series.title,
    season.title,
    episode.title,
    episode.code,
    // So "s01e1" and "1x01" style searches still land on the right episode.
    `${episode.seasonNumber}x${episode.episodeNumber ?? ""}`,
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

/**
 * The tree, narrowed to what the search matches.
 *
 * A show whose *own* title matches keeps all of its episodes: someone typing
 * "Sopranos" wants the show, not an empty show. Otherwise only the matching
 * episodes survive, and a season with none of them is dropped along with a
 * show that has no seasons left.
 */
export function filterSeries(
  series: readonly ProcessingSeries[],
  rawQuery: string,
  locale = "en",
): ProcessingSeries[] {
  const query = rawQuery.trim().toLocaleLowerCase(locale);
  if (!query) return [...series];

  const filtered: ProcessingSeries[] = [];
  for (const show of series) {
    const showMatches = show.title.toLocaleLowerCase(locale).includes(query);
    const seasons: ProcessingSeason[] = [];

    for (const season of show.seasons) {
      const episodes = showMatches
        ? season.episodes
        : season.episodes.filter((episode) =>
            matchesQuery(show, season, episode, query),
          );
      if (episodes.length === 0) continue;
      seasons.push(
        episodes === season.episodes ? season : { ...season, episodes },
      );
    }

    if (seasons.length === 0) continue;
    filtered.push(seasons === show.seasons ? show : { ...show, seasons });
  }
  return filtered;
}

/**
 * Which shows and seasons a search has opened.
 *
 * A narrowed tree is opened so the matches are visible; the operator's own
 * expansions are left alone, so clearing the search returns the page to what
 * they had open rather than to a collapsed list.
 */
export function autoExpandedIds(
  series: readonly ProcessingSeries[],
  rawQuery: string,
): { seriesIds: string[]; seasonIds: string[] } {
  if (!rawQuery.trim()) return { seriesIds: [], seasonIds: [] };
  return {
    seriesIds: series.map((show) => show.seriesId),
    seasonIds: series.flatMap((show) =>
      show.seasons.map((season) => season.seasonId),
    ),
  };
}

/** Whether a bulk press should be offered at all, and what it would do. */
export function bulkEligibility(counts: ProcessingStateCounts): {
  enabled: boolean;
  eligible: number;
} {
  return { enabled: counts.eligible > 0, eligible: counts.eligible };
}

/**
 * How a title's rungs divide into what is on disk and what a run would add.
 *
 * Both halves come from the server's own plan, so the chips under an episode
 * say the same thing the job would do.
 */
export function rungBreakdown(episode: {
  package: { rungs: number[] } | null;
  plan: { ladder: number[]; missingRungs: number[] } | null;
}): { present: number[]; planned: number[] } {
  const present = [...(episode.package?.rungs ?? [])].sort(
    (left, right) => right - left,
  );
  const planned = episode.plan
    ? [...episode.plan.ladder].sort((left, right) => right - left)
    : present;
  return { present, planned };
}

export type EpisodeAction =
  /** The source is gone; the package, if any, is all there is. */
  | "unavailable"
  /** A job is already on it. */
  | "active"
  /** Nothing left to build. */
  | "complete"
  /** The file has not been probed, so no plan can be made yet. */
  | "unprobed"
  | "start";

/** The single action an episode row offers, chosen once so the UI cannot differ. */
export function episodeAction(episode: ProcessingEpisode): EpisodeAction {
  if (episode.activeJobId) return "active";
  if (!episode.sourceAvailable) return "unavailable";
  if (!episode.probed || !episode.plan) return "unprobed";
  if (!episode.processable) return "complete";
  return "start";
}

/**
 * One line summarising what a bulk press achieved.
 *
 * Deliberately reports every outcome rather than only the successes: a press
 * that queued eight of eleven episodes has to say what happened to the other
 * three, or the operator is left believing the show is fully under way.
 */
export function describeBulkOutcome(
  outcome: {
    queued: number;
    alreadyQueued: number;
    alreadyComplete: number;
    unavailable: number;
    failed: number;
  },
  t: (key: string) => string,
  format: (template: string, values: Record<string, string>) => string,
): string {
  const parts = [
    format(t("processing.tv.bulkQueued"), { count: String(outcome.queued) }),
  ];
  if (outcome.alreadyQueued > 0) {
    parts.push(
      format(t("processing.tv.bulkAlreadyQueued"), {
        count: String(outcome.alreadyQueued),
      }),
    );
  }
  if (outcome.alreadyComplete > 0) {
    parts.push(
      format(t("processing.tv.bulkAlreadyComplete"), {
        count: String(outcome.alreadyComplete),
      }),
    );
  }
  if (outcome.unavailable > 0) {
    parts.push(
      format(t("processing.tv.bulkUnavailable"), {
        count: String(outcome.unavailable),
      }),
    );
  }
  if (outcome.failed > 0) {
    parts.push(
      format(t("processing.tv.bulkFailed"), {
        count: String(outcome.failed),
      }),
    );
  }
  return parts.join(" · ");
}

/**
 * How a job identifies itself in the queue.
 *
 * "Pilot" is not an identity when six shows have one. An episode job is named
 * by its show and its code; a film keeps its own title.
 */
export function jobLabel(
  title:
    | { kind: "movie" | "episode"; seriesTitle?: string; code?: string; title: string }
    | undefined,
  fallback: string,
): { primary: string; secondary: string | null } {
  if (!title) return { primary: fallback, secondary: null };
  if (title.kind === "movie") return { primary: title.title, secondary: null };
  return {
    primary: title.seriesTitle ?? title.title,
    secondary: [title.code, title.title].filter(Boolean).join(" · "),
  };
}

/** A stable, human count line for a season or a show. */
export function summariseCounts(
  counts: ProcessingStateCounts,
  t: (key: string) => string,
  format: (template: string, values: Record<string, string>) => string,
): string {
  const parts: string[] = [];
  if (counts.complete > 0) {
    parts.push(
      format(t("processing.tv.countProcessed"), {
        count: String(counts.complete),
      }),
    );
  }
  if (counts.partial > 0) {
    parts.push(
      format(t("processing.tv.countPartial"), {
        count: String(counts.partial),
      }),
    );
  }
  if (counts.unprocessed > 0) {
    parts.push(
      format(t("processing.tv.countUnprocessed"), {
        count: String(counts.unprocessed),
      }),
    );
  }
  if (counts.active > 0) {
    parts.push(
      format(t("processing.tv.countActive"), { count: String(counts.active) }),
    );
  }
  if (counts.unavailable > 0) {
    parts.push(
      format(t("processing.tv.countUnavailable"), {
        count: String(counts.unavailable),
      }),
    );
  }
  return parts.join(" · ");
}
