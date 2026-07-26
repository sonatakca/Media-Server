// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getItemDisplayMetadata,
  saveItemMetadataOverride,
} from "./itemMetadataPreferences";
import type { JellyfinItem } from "./types";

beforeEach(() => {
  window.localStorage.clear();
});

describe("item metadata preferences", () => {
  it("switches saved movie and show text with the website language", () => {
    saveItemMetadataOverride({
      itemId: "movie-1",
      titles: { en: "English title", tr: "Türkçe ad" },
      overviews: {
        en: "English description.",
        tr: "Türkçe açıklama.",
      },
    });

    const item = {
      Id: "movie-1",
      Name: "Jellyfin title",
      Overview: "Jellyfin description.",
      Type: "Movie",
    } as JellyfinItem;

    expect(getItemDisplayMetadata(item, "en")).toEqual({
      title: "English title",
      overview: "English description.",
    });
    expect(getItemDisplayMetadata(item, "tr")).toEqual({
      title: "Türkçe ad",
      overview: "Türkçe açıklama.",
    });
  });

  it("falls back to Jellyfin metadata when no localized value is saved", () => {
    const item = {
      Id: "series-1",
      Name: "Jellyfin show",
      Overview: "Jellyfin overview.",
      Type: "Series",
    } as JellyfinItem;

    expect(getItemDisplayMetadata(item, "tr")).toEqual({
      title: "Jellyfin show",
      overview: "Jellyfin overview.",
    });
  });
});
