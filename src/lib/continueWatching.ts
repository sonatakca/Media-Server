import type { JellyfinItem } from "./types";

interface ContinueWatchingCandidate {
  item: JellyfinItem;
  index: number;
  watchedAt?: number;
}

function getWatchedTimestamp(item: JellyfinItem): number | undefined {
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

function getIdentityValue(value?: string): string | undefined {
  const identity = value?.trim();

  return identity || undefined;
}

function getEpisodeSeriesKey(item: JellyfinItem): string {
  const seriesId = getIdentityValue(item.SeriesId);
  const seriesName = getIdentityValue(item.SeriesName);
  const parentId = getIdentityValue(item.ParentId);

  // Resume feeds can contain several unfinished episodes; show one per series.
  if (seriesId) {
    return seriesId;
  }

  if (seriesName) {
    return seriesName;
  }

  if (parentId) {
    return parentId;
  }

  return item.Id;
}

function keepLatest(
  current: ContinueWatchingCandidate | undefined,
  candidate: ContinueWatchingCandidate,
): ContinueWatchingCandidate {
  if (!current) {
    return candidate;
  }

  if (candidate.watchedAt === undefined) {
    return current;
  }

  if (
    current.watchedAt === undefined ||
    candidate.watchedAt > current.watchedAt
  ) {
    return candidate;
  }

  return current;
}

function compareCandidates(
  left: ContinueWatchingCandidate,
  right: ContinueWatchingCandidate,
): number {
  if (left.watchedAt !== undefined && right.watchedAt !== undefined) {
    return right.watchedAt - left.watchedAt || left.index - right.index;
  }

  if (left.watchedAt !== undefined) {
    return -1;
  }

  if (right.watchedAt !== undefined) {
    return 1;
  }

  return left.index - right.index;
}

export function getLatestContinueWatchingItems(
  items: JellyfinItem[],
): JellyfinItem[] {
  const distinctItems = new Map<string, ContinueWatchingCandidate>();

  items.forEach((item, index) => {
    const candidate = {
      item,
      index,
      watchedAt: getWatchedTimestamp(item),
    };

    distinctItems.set(
      item.Id,
      keepLatest(distinctItems.get(item.Id), candidate),
    );
  });

  const latestItems = new Map<string, ContinueWatchingCandidate>();

  for (const candidate of distinctItems.values()) {
    const key =
      candidate.item.Type === "Episode"
        ? `episode:${getEpisodeSeriesKey(candidate.item)}`
        : `item:${candidate.item.Id}`;

    latestItems.set(key, keepLatest(latestItems.get(key), candidate));
  }

  return Array.from(latestItems.values())
    .sort(compareCandidates)
    .map(({ item }) => item);
}
