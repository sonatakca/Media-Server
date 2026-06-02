import {
  getAllBoxSetItems,
  getAllMovieItems,
  getAllSeriesEpisodes,
  getBoxSetItems,
  getContinueWatchingItems,
} from "./jellyfinApi";
import { sortCollectionItemsForWatching } from "./collectionUtils";
import type { JellyfinItem } from "./types";
import { DEFAULT_COMPLETION_THRESHOLD, isItemCompleted } from "./watchStatus";

export { DEFAULT_COMPLETION_THRESHOLD };

interface SmartContinueCandidate {
  item: JellyfinItem;
  index: number;
  activeAt?: number;
}

interface SeriesResumeGroup {
  seriesId: string;
  candidates: SmartContinueCandidate[];
}

interface SmartContinueDependencies {
  getAllSeriesEpisodes: (seriesId: string) => Promise<JellyfinItem[]>;
  getAllMovieItems: () => Promise<JellyfinItem[]>;
  getAllBoxSetItems: () => Promise<JellyfinItem[]>;
  getBoxSetItems: (boxSetId: string) => Promise<JellyfinItem[]>;
}

const defaultDependencies: SmartContinueDependencies = {
  getAllSeriesEpisodes,
  getAllMovieItems,
  getAllBoxSetItems,
  getBoxSetItems,
};

function getActivityTimestamp(item: JellyfinItem): number | undefined {
  const dates = [
    item.UserData?.LastPlayedDate,
    item.LastPlayedDate,
    item.DatePlayed,
    item.DateCreated,
    item.PremiereDate,
  ];

  for (const date of dates) {
    if (!date) {
      continue;
    }

    const timestamp = Date.parse(date);

    if (!Number.isNaN(timestamp)) {
      return timestamp;
    }
  }

  return undefined;
}

function compareCandidates(
  left: SmartContinueCandidate,
  right: SmartContinueCandidate,
): number {
  if (left.activeAt !== undefined && right.activeAt !== undefined) {
    return right.activeAt - left.activeAt || left.index - right.index;
  }

  if (left.activeAt !== undefined) {
    return -1;
  }

  if (right.activeAt !== undefined) {
    return 1;
  }

  return left.index - right.index;
}

export function isSmartContinueCompleted(
  item: JellyfinItem,
  completionThreshold = DEFAULT_COMPLETION_THRESHOLD,
): boolean {
  return isItemCompleted(item, completionThreshold);
}

function getEpisodeSeasonNumber(item: JellyfinItem): number | undefined {
  return typeof item.ParentIndexNumber === "number"
    ? item.ParentIndexNumber
    : undefined;
}

function getEpisodeNumber(item: JellyfinItem): number | undefined {
  return typeof item.IndexNumber === "number" ? item.IndexNumber : undefined;
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
): number {
  if (left !== undefined && right !== undefined && left !== right) {
    return left - right;
  }

  if (left !== undefined && right === undefined) {
    return -1;
  }

  if (left === undefined && right !== undefined) {
    return 1;
  }

  return 0;
}

function compareEpisodeOrder(left: JellyfinItem, right: JellyfinItem): number {
  const seasonCompare = compareOptionalNumbers(
    getEpisodeSeasonNumber(left),
    getEpisodeSeasonNumber(right),
  );

  if (seasonCompare !== 0) {
    return seasonCompare;
  }

  const episodeCompare = compareOptionalNumbers(
    getEpisodeNumber(left),
    getEpisodeNumber(right),
  );

  if (episodeCompare !== 0) {
    return episodeCompare;
  }

  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true, sensitivity: "base" },
  );
}

function getLatestEpisode(episodes: JellyfinItem[]): JellyfinItem | null {
  return [...episodes].sort(compareEpisodeOrder).at(-1) ?? null;
}

function mergeItemsById(items: JellyfinItem[]): JellyfinItem[] {
  const merged = new Map<string, JellyfinItem>();

  for (const item of items) {
    merged.set(item.Id, { ...merged.get(item.Id), ...item });
  }

  return Array.from(merged.values());
}

function getMaxActivityTimestamp(items: JellyfinItem[]): number | undefined {
  return items.reduce<number | undefined>((latest, item) => {
    const timestamp = getActivityTimestamp(item);

    if (timestamp === undefined) {
      return latest;
    }

    return latest === undefined || timestamp > latest ? timestamp : latest;
  }, undefined);
}

async function buildSeriesCandidate(
  group: SeriesResumeGroup,
  deps: SmartContinueDependencies,
  completionThreshold: number,
  fallbackIndex: number,
): Promise<SmartContinueCandidate | null> {
  const fetchedEpisodes = await deps
    .getAllSeriesEpisodes(group.seriesId)
    .catch(() => []);
  const episodes = mergeItemsById([
    ...fetchedEpisodes.filter((item) => item.Type === "Episode"),
    ...group.candidates.map((candidate) => candidate.item),
  ]).sort(compareEpisodeOrder);

  if (episodes.length === 0) {
    return (
      [...group.candidates]
        .filter(
          (candidate) =>
            !isSmartContinueCompleted(candidate.item, completionThreshold),
        )
        .sort(compareCandidates)[0] ?? null
    );
  }

  const completedEpisodes = episodes.filter((episode) =>
    isSmartContinueCompleted(episode, completionThreshold),
  );
  const latestCompletedEpisode = getLatestEpisode(completedEpisodes);

  if (!latestCompletedEpisode) {
    return (
      [...group.candidates]
        .filter(
          (candidate) =>
            !isSmartContinueCompleted(candidate.item, completionThreshold),
        )
        .sort(compareCandidates)[0] ?? null
    );
  }

  // Jellyfin's resume feed can keep an old 94%-watched episode around after
  // later episodes are completed. Once we know the latest completed episode in
  // a show, every resume candidate at or before that point is stale; the row
  // should advance to the next real episode, or disappear if the show is done.
  const nextEpisode =
    episodes.find(
      (episode) =>
        compareEpisodeOrder(episode, latestCompletedEpisode) > 0 &&
        !isSmartContinueCompleted(episode, completionThreshold),
    ) ?? null;

  if (!nextEpisode) {
    return null;
  }

  return {
    item: nextEpisode,
    index: fallbackIndex,
    activeAt:
      getMaxActivityTimestamp([
        latestCompletedEpisode,
        ...group.candidates.map((candidate) => candidate.item),
      ]) ?? getActivityTimestamp(nextEpisode),
  };
}

function getTmdbCollectionIds(item: JellyfinItem): string[] {
  const providerIds = item.ProviderIds ?? {};

  return Object.entries(providerIds)
    .filter(([key, value]) => {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      return (
        Boolean(value?.trim()) &&
        normalizedKey.includes("tmdb") &&
        normalizedKey.includes("collection")
      );
    })
    .map(([, value]) => value.trim())
    .filter(Boolean);
}

function getNextMovieInOrderedCollection(
  movie: JellyfinItem,
  collectionItems: JellyfinItem[],
  completionThreshold: number,
): JellyfinItem | null {
  const orderedMovies = sortCollectionItemsForWatching(
    collectionItems.filter((item) => item.Type === "Movie"),
  );
  const currentIndex = orderedMovies.findIndex((item) => item.Id === movie.Id);

  if (currentIndex < 0) {
    return null;
  }

  return (
    orderedMovies
      .slice(currentIndex + 1)
      .find((item) => !isSmartContinueCompleted(item, completionThreshold)) ??
    null
  );
}

async function getNextMovieFromTmdbCollection(
  movie: JellyfinItem,
  deps: SmartContinueDependencies,
  completionThreshold: number,
): Promise<JellyfinItem | null> {
  const tmdbCollectionIds = getTmdbCollectionIds(movie);

  if (tmdbCollectionIds.length === 0) {
    return null;
  }

  const movieItems = await deps.getAllMovieItems().catch(() => []);
  const collectionItems = movieItems.filter((candidate) => {
    const candidateCollectionIds = getTmdbCollectionIds(candidate);
    return tmdbCollectionIds.some((collectionId) =>
      candidateCollectionIds.includes(collectionId),
    );
  });

  return getNextMovieInOrderedCollection(
    movie,
    collectionItems,
    completionThreshold,
  );
}

async function getNextMovieFromBoxSet(
  movie: JellyfinItem,
  deps: SmartContinueDependencies,
  completionThreshold: number,
): Promise<JellyfinItem | null> {
  const boxSets = await deps.getAllBoxSetItems().catch(() => []);

  for (const boxSet of boxSets) {
    const collectionItems = await deps
      .getBoxSetItems(boxSet.Id)
      .catch(() => []);

    if (!collectionItems.some((item) => item.Id === movie.Id)) {
      continue;
    }

    const nextMovie = getNextMovieInOrderedCollection(
      movie,
      collectionItems,
      completionThreshold,
    );

    if (nextMovie) {
      return nextMovie;
    }
  }

  return null;
}

async function buildMovieCandidate(
  candidate: SmartContinueCandidate,
  deps: SmartContinueDependencies,
  completionThreshold: number,
): Promise<SmartContinueCandidate | null> {
  if (!isSmartContinueCompleted(candidate.item, completionThreshold)) {
    return candidate;
  }

  const nextMovie =
    (await getNextMovieFromTmdbCollection(
      candidate.item,
      deps,
      completionThreshold,
    )) ??
    (await getNextMovieFromBoxSet(candidate.item, deps, completionThreshold));

  if (!nextMovie) {
    return null;
  }

  return {
    item: nextMovie,
    index: candidate.index,
    activeAt: candidate.activeAt,
  };
}

export async function buildSmartContinueWatchingItems(
  resumeItems: JellyfinItem[],
  {
    completionThreshold = DEFAULT_COMPLETION_THRESHOLD,
    dependencies = defaultDependencies,
  }: {
    completionThreshold?: number;
    dependencies?: SmartContinueDependencies;
  } = {},
): Promise<JellyfinItem[]> {
  const candidates = resumeItems.map((item, index) => ({
    item,
    index,
    activeAt: getActivityTimestamp(item),
  }));
  const seriesGroups = new Map<string, SeriesResumeGroup>();
  const outputCandidates: SmartContinueCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.item.Type === "Episode" && candidate.item.SeriesId) {
      const existingGroup = seriesGroups.get(candidate.item.SeriesId) ?? {
        seriesId: candidate.item.SeriesId,
        candidates: [],
      };
      existingGroup.candidates.push(candidate);
      seriesGroups.set(existingGroup.seriesId, existingGroup);
      continue;
    }

    if (candidate.item.Type === "Movie") {
      const movieCandidate = await buildMovieCandidate(
        candidate,
        dependencies,
        completionThreshold,
      );

      if (movieCandidate) {
        outputCandidates.push(movieCandidate);
      }
      continue;
    }

    if (!isSmartContinueCompleted(candidate.item, completionThreshold)) {
      outputCandidates.push(candidate);
    }
  }

  for (const group of seriesGroups.values()) {
    const seriesCandidate = await buildSeriesCandidate(
      group,
      dependencies,
      completionThreshold,
      Math.min(...group.candidates.map((candidate) => candidate.index)),
    );

    if (seriesCandidate) {
      outputCandidates.push(seriesCandidate);
    }
  }

  const seenIds = new Set<string>();

  return outputCandidates
    .sort(compareCandidates)
    .map(({ item }) => item)
    .filter((item) => {
      if (seenIds.has(item.Id)) {
        return false;
      }

      seenIds.add(item.Id);
      return true;
    });
}

export async function getSmartContinueWatchingItems(options?: {
  completionThreshold?: number;
}): Promise<JellyfinItem[]> {
  const resumeItems = await getContinueWatchingItems();

  return buildSmartContinueWatchingItems(resumeItems, options);
}
