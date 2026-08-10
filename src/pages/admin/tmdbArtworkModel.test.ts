import { describe, expect, it } from "vitest";
import type { ArtworkCandidate } from "../../lib/artworkApi";
import type { MediaItem } from "../../lib/types";
import {
  filterTitles,
  formatDimensions,
  getArtworkErrorKey,
  getLanguageLabelKey,
  hasStoredArtwork,
  isArtworkEligible,
  isKindLocked,
  selectCandidates,
} from "./tmdbArtworkModel";

function candidate(
  overrides: Partial<ArtworkCandidate> = {},
): ArtworkCandidate {
  return {
    kind: "poster",
    imageType: "primary",
    filePath: "/a.jpg",
    language: "en",
    width: 2000,
    height: 3000,
    aspectRatio: 0.667,
    voteAverage: 8,
    voteCount: 40,
    previewUrl: "https://image.tmdb.org/t/p/w342/a.jpg",
    ...overrides,
  };
}

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    Id: "item-1",
    Name: "Dune",
    Type: "Movie",
    ProductionYear: 2021,
    ...overrides,
  } as MediaItem;
}

describe("title selection", () => {
  it("offers only titles that can carry their own artwork", () => {
    // A season or an episode inherits the series' artwork, so listing one here
    // would promise a choice the server refuses to make.
    expect(isArtworkEligible(item())).toBe(true);
    expect(isArtworkEligible(item({ Type: "Series" }))).toBe(true);
    expect(isArtworkEligible(item({ Type: "Season" }))).toBe(false);
    expect(isArtworkEligible(item({ Type: "Episode" }))).toBe(false);
  });

  it("searches title, original title, year and id together", () => {
    const titles = [
      item({ Id: "a", Name: "Dune", ProductionYear: 2021 }),
      item({ Id: "b", Name: "Ezel", OriginalTitle: "Ezel" }),
      item({ Id: "c-8bb2", Name: "Arrival", ProductionYear: 2016 }),
    ];

    expect(filterTitles(titles, "dune").map((entry) => entry.Id)).toEqual(["a"]);
    expect(filterTitles(titles, "2016").map((entry) => entry.Id)).toEqual(["c-8bb2"]);
    expect(filterTitles(titles, "c-8bb").map((entry) => entry.Id)).toEqual(["c-8bb2"]);
    expect(filterTitles(titles, "   ")).toHaveLength(3);
  });
});

describe("candidate filtering", () => {
  const candidates = [
    candidate({ filePath: "/en.jpg", language: "en" }),
    candidate({ filePath: "/tr.jpg", language: "tr" }),
    candidate({ filePath: "/neutral.jpg", language: null }),
    candidate({ filePath: "/wide.jpg", kind: "backdrop", language: null }),
  ];

  it("keeps each provider set separate", () => {
    expect(
      selectCandidates(candidates, "poster", "all").map((entry) => entry.filePath),
    ).toEqual(["/en.jpg", "/tr.jpg", "/neutral.jpg"]);
    expect(
      selectCandidates(candidates, "backdrop", "all").map((entry) => entry.filePath),
    ).toEqual(["/wide.jpg"]);
    expect(selectCandidates(candidates, "logo", "all")).toEqual([]);
  });

  it("treats artwork with no text as its own filter rather than a missing value", () => {
    expect(
      selectCandidates(candidates, "poster", "none").map((entry) => entry.filePath),
    ).toEqual(["/neutral.jpg"]);
    expect(
      selectCandidates(candidates, "poster", "tr").map((entry) => entry.filePath),
    ).toEqual(["/tr.jpg"]);
    expect(getLanguageLabelKey(null)).toBe("tmdbArtwork.language.none");
    expect(getLanguageLabelKey("tr")).toBe("tmdbArtwork.language.turkish");
  });
});

describe("stored artwork state", () => {
  it("maps a provider set onto the stored image type it replaces", () => {
    expect(isKindLocked(["primary"], "poster")).toBe(true);
    expect(isKindLocked(["primary"], "backdrop")).toBe(false);
    expect(isKindLocked(["logo", "backdrop"], "logo")).toBe(true);
  });

  it("only counts the first image of a type as the one on display", () => {
    const current = [
      { imageType: "primary", imageIndex: 0 },
      { imageType: "backdrop", imageIndex: 1 },
    ];

    expect(hasStoredArtwork(current, "poster")).toBe(true);
    // A backdrop at index 1 is an extra, not the one the detail page shows.
    expect(hasStoredArtwork(current, "backdrop")).toBe(false);
    expect(hasStoredArtwork(current, "logo")).toBe(false);
  });

  it("reads unknown dimensions as a dash rather than an empty product", () => {
    expect(formatDimensions(2000, 3000)).toBe("2000 × 3000");
    expect(formatDimensions(null, 3000)).toBe("—");
    expect(formatDimensions(null, null)).toBe("—");
  });
});

describe("artwork errors", () => {
  it("distinguishes never-identified from cannot-have-artwork", () => {
    // Both arrive as a failed load; telling the operator which one it is is the
    // difference between an actionable message and a shrug.
    expect(getArtworkErrorKey("PROVIDER_ID_MISSING")).toBe(
      "tmdbArtwork.itemMetadataRequiresMatch",
    );
    expect(getArtworkErrorKey("ARTWORK_NOT_APPLICABLE")).toBe(
      "tmdbArtwork.artworkNotApplicable",
    );
    expect(getArtworkErrorKey(undefined)).toBe("tmdbArtwork.couldNotLoadImages");
  });
});
