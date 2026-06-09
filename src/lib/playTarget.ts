import { getAllSeriesEpisodes } from "./jellyfinApi";
import { getRouteForItem } from "./routes";
import type { JellyfinItem } from "./types";

function getEpisodeOrderValue(item: JellyfinItem): number {
  const seasonNumber = item.ParentIndexNumber ?? 0;
  const episodeNumber = item.IndexNumber ?? 0;

  return seasonNumber * 10_000 + episodeNumber;
}

function getNextEpisodeForSeries(
  episodes: JellyfinItem[],
): JellyfinItem | null {
  const sortedEpisodes = [...episodes].sort(
    (left, right) => getEpisodeOrderValue(left) - getEpisodeOrderValue(right),
  );

  const inProgressEpisode = sortedEpisodes.find(
    (episode) =>
      !episode.UserData?.Played &&
      (episode.UserData?.PlaybackPositionTicks ?? 0) > 0,
  );

  if (inProgressEpisode) {
    return inProgressEpisode;
  }

  const firstUnplayedEpisode = sortedEpisodes.find(
    (episode) => !episode.UserData?.Played,
  );

  return firstUnplayedEpisode ?? sortedEpisodes[0] ?? null;
}

export async function getPlayTargetForItem(
  item: JellyfinItem,
): Promise<string> {
  if (item.Type !== "Series") {
    return `/watch/${item.Id}`;
  }

  const episodes = await getAllSeriesEpisodes(item.Id);
  const targetEpisode = getNextEpisodeForSeries(episodes);

  return targetEpisode ? `/watch/${targetEpisode.Id}` : getRouteForItem(item);
}
