import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAllSeriesEpisodes } from "./jellyfinApi";
import { getPlayTargetForItem, getPlayTargetItemForItem } from "./playTarget";
import type { JellyfinItem } from "./types";

vi.mock("./jellyfinApi", () => ({
  getAllSeriesEpisodes: vi.fn(),
}));

const mockedGetAllSeriesEpisodes = vi.mocked(getAllSeriesEpisodes);

describe("play target resolver", () => {
  beforeEach(() => {
    mockedGetAllSeriesEpisodes.mockReset();
  });

  it("uses movie items as direct playback targets from details pages", async () => {
    const movie: JellyfinItem = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
      MediaType: "Video",
    };

    await expect(getPlayTargetItemForItem(movie)).resolves.toBe(movie);
    await expect(getPlayTargetForItem(movie)).resolves.toBe("/watch/movie-1");
  });

  it("uses the in-progress series episode as the playback target", async () => {
    const series: JellyfinItem = {
      Id: "series-1",
      Name: "Series",
      Type: "Series",
    };
    const firstEpisode: JellyfinItem = {
      Id: "episode-1",
      Name: "Episode 1",
      Type: "Episode",
      ParentIndexNumber: 1,
      IndexNumber: 1,
      UserData: { Played: false, PlaybackPositionTicks: 0 },
    };
    const inProgressEpisode: JellyfinItem = {
      Id: "episode-2",
      Name: "Episode 2",
      Type: "Episode",
      ParentIndexNumber: 1,
      IndexNumber: 2,
      UserData: { Played: false, PlaybackPositionTicks: 500_000_000 },
    };

    mockedGetAllSeriesEpisodes.mockResolvedValue([
      inProgressEpisode,
      firstEpisode,
    ]);

    await expect(getPlayTargetItemForItem(series)).resolves.toBe(
      inProgressEpisode,
    );
    await expect(getPlayTargetForItem(series)).resolves.toBe(
      "/watch/episode-2",
    );
  });

  it("falls back to the series library route when a show has no episodes", async () => {
    const series: JellyfinItem = {
      Id: "series-1",
      Name: "Series",
      Type: "Series",
    };

    mockedGetAllSeriesEpisodes.mockResolvedValue([]);

    await expect(getPlayTargetItemForItem(series)).resolves.toBeNull();
    await expect(getPlayTargetForItem(series)).resolves.toBe(
      "/library/series-1",
    );
  });
});
