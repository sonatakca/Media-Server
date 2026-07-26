// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  getItemDisplayMetadata,
  getItemLogoUrl,
  saveItemLogoOverride,
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

  it("switches saved logos by language without erasing localized text", () => {
    saveItemMetadataOverride({
      itemId: "movie-1",
      titles: { en: "English title", tr: "Türkçe ad" },
    });
    saveItemLogoOverride("movie-1", "en", "https://image/en-logo.png");
    saveItemLogoOverride("movie-1", "tr", "https://image/tr-logo.png");

    const item = {
      Id: "movie-1",
      Name: "Movie",
      Type: "Movie",
    } as JellyfinItem;

    expect(getItemLogoUrl(item, "en", "/fallback.png")).toBe(
      "https://image/en-logo.png",
    );
    expect(getItemLogoUrl(item, "tr", "/fallback.png")).toBe(
      "https://image/tr-logo.png",
    );
    expect(getItemDisplayMetadata(item, "tr").title).toBe("Türkçe ad");
  });
});
