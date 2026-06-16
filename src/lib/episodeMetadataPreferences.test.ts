// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getEpisodeDisplayMetadata,
  getSeriesEpisodeThumbnailLanguage,
  saveEpisodeMetadataOverrides,
} from "./episodeMetadataPreferences";
import type { JellyfinItem } from "./types";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function createEpisode(overrides: Partial<JellyfinItem> = {}): JellyfinItem {
  return {
    Id: "episode-1",
    Name: "Jellyfin name",
    Type: "Episode",
    SeriesId: "series-1",
    ParentIndexNumber: 1,
    IndexNumber: 1,
    Overview: "Jellyfin overview",
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    value: createMemoryStorage(),
    configurable: true,
  });
  window.localStorage.clear();
});

describe("episode metadata preferences", () => {
  it("switches saved episode text by the current website language", () => {
    saveEpisodeMetadataOverrides(
      [
        {
          episodeId: "episode-1",
          seriesId: "series-1",
          seasonNumber: 1,
          episodeNumber: 1,
          titles: {
            en: "English episode title",
            tr: "Türkçe bölüm adı",
          },
          overviews: {
            en: "English episode description.",
            tr: "Türkçe bölüm açıklaması.",
          },
          thumbnail: {
            url: "https://image.tmdb.org/t/p/w780/still.jpg",
            filePath: "/still.jpg",
            language: "en",
          },
        },
      ],
      { seriesId: "series-1", thumbnailLanguage: "en" },
    );

    expect(getEpisodeDisplayMetadata(createEpisode(), "en")).toEqual({
      title: "English episode title",
      overview: "English episode description.",
      thumbnailUrl: "https://image.tmdb.org/t/p/w780/still.jpg",
    });
    expect(getEpisodeDisplayMetadata(createEpisode(), "tr")).toEqual({
      title: "Türkçe bölüm adı",
      overview: "Türkçe bölüm açıklaması.",
      thumbnailUrl: "https://image.tmdb.org/t/p/w780/still.jpg",
    });
    expect(getSeriesEpisodeThumbnailLanguage("series-1")).toBe("en");
  });

  it("can match a saved episode by series, season, and episode numbers", () => {
    saveEpisodeMetadataOverrides([
      {
        episodeId: "old-jellyfin-id",
        seriesId: "series-1",
        seasonNumber: 2,
        episodeNumber: 3,
        titles: {
          en: "Matched by order",
          tr: "Sıraya göre eşleşti",
        },
      },
    ]);

    expect(
      getEpisodeDisplayMetadata(
        createEpisode({
          Id: "new-jellyfin-id",
          ParentIndexNumber: 2,
          IndexNumber: 3,
        }),
        "tr",
      ).title,
    ).toBe("Sıraya göre eşleşti");
  });
});
