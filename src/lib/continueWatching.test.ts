import { describe, expect, it } from "vitest";
import { getLatestContinueWatchingItems } from "./continueWatching";
import type { JellyfinItem } from "./types";

function createItem(
  id: string,
  values: Partial<JellyfinItem> = {},
): JellyfinItem {
  return {
    Id: id,
    Name: id,
    ...values,
  };
}

describe("getLatestContinueWatchingItems", () => {
  it("keeps only the latest watched episode from each series", () => {
    const result = getLatestContinueWatchingItems([
      createItem("ezel-e1", {
        Type: "Episode",
        SeriesId: "ezel",
        UserData: { LastPlayedDate: "2026-01-01T10:00:00Z" },
      }),
      createItem("chernobyl-e1", {
        Type: "Episode",
        SeriesId: "chernobyl",
        LastPlayedDate: "2026-01-02T10:00:00Z",
      }),
      createItem("ezel-e2", {
        Type: "Episode",
        SeriesId: "ezel",
        DatePlayed: "2026-01-04T10:00:00Z",
      }),
      createItem("chernobyl-e4", {
        Type: "Episode",
        SeriesId: "chernobyl",
        DateCreated: "2026-01-03T10:00:00Z",
      }),
    ]);

    expect(result.map((item) => item.Id)).toEqual(["ezel-e2", "chernobyl-e4"]);
  });

  it("uses fallback series keys and keeps non-episodes unless their ID repeats", () => {
    const result = getLatestContinueWatchingItems([
      createItem("named-first", {
        Type: "Episode",
        SeriesName: "Shared Name",
      }),
      createItem("named-second", {
        Type: "Episode",
        SeriesName: "Shared Name",
      }),
      createItem("parent-first", {
        Type: "Episode",
        ParentId: "season-parent",
        DateCreated: "2026-01-01",
      }),
      createItem("parent-latest", {
        Type: "Episode",
        ParentId: "season-parent",
        DateCreated: "2026-01-02",
      }),
      createItem("movie-one", { Type: "Movie" }),
      createItem("movie-two", { Type: "Movie" }),
      createItem("movie-two", { Type: "Movie" }),
      createItem("episode-with-no-series-one", { Type: "Episode" }),
      createItem("episode-with-no-series-two", { Type: "Episode" }),
    ]);

    expect(result.map((item) => item.Id)).toEqual([
      "parent-latest",
      "named-first",
      "movie-one",
      "movie-two",
      "episode-with-no-series-one",
      "episode-with-no-series-two",
    ]);
  });

  it("prefers played dates over later metadata dates for an item", () => {
    const result = getLatestContinueWatchingItems([
      createItem("metadata-newer", {
        Type: "Episode",
        SeriesId: "dated-series",
        UserData: { LastPlayedDate: "2026-01-01" },
        PremiereDate: "2030-01-01",
      }),
      createItem("played-newer", {
        Type: "Episode",
        SeriesId: "dated-series",
        LastPlayedDate: "2026-02-01",
      }),
    ]);

    expect(result.map((item) => item.Id)).toEqual(["played-newer"]);
  });

  it("sorts dated items first and preserves undated ordering", () => {
    const result = getLatestContinueWatchingItems([
      createItem("undated-first", { Type: "Movie" }),
      createItem("dated-older", {
        Type: "Movie",
        PremiereDate: "2025-01-01",
      }),
      createItem("undated-second", { Type: "Video" }),
      createItem("dated-newer", {
        Type: "Movie",
        UserData: { LastPlayedDate: "2026-01-01" },
      }),
    ]);

    expect(result.map((item) => item.Id)).toEqual([
      "dated-newer",
      "dated-older",
      "undated-first",
      "undated-second",
    ]);
  });

  it("does not reorder items when every usable date is missing", () => {
    const result = getLatestContinueWatchingItems([
      createItem("movie", { Type: "Movie" }),
      createItem("episode-first", {
        Type: "Episode",
        SeriesId: "series",
      }),
      createItem("episode-second", {
        Type: "Episode",
        SeriesId: "series",
      }),
      createItem("video", { Type: "Video" }),
    ]);

    expect(result.map((item) => item.Id)).toEqual([
      "movie",
      "episode-first",
      "video",
    ]);
  });
});
