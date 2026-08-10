import { describe, expect, it } from "vitest";
import {
  buildSortTitle,
  isExtraDirectory,
  isIgnoredEntry,
  isTrailerFile,
  parseEpisodeName,
  parseMovieName,
  parseSeasonFolder,
  parseSubtitleSuffix,
  splitExtension,
} from "./nameParser";

describe("parseMovieName", () => {
  it("reads a parenthesized year", () => {
    expect(parseMovieName("The Matrix (1999)")).toEqual({
      title: "The Matrix",
      year: 1999,
    });
  });

  it("strips scene release metadata after the year", () => {
    expect(
      parseMovieName("The.Matrix.1999.1080p.BluRay.x264-SomeGroup"),
    ).toEqual({ title: "The Matrix", year: 1999 });
  });

  it("keeps a leading year as part of the title", () => {
    expect(parseMovieName("1917 2019 2160p WEB-DL")).toEqual({
      title: "1917",
      year: 2019,
    });
  });

  it("keeps multi-word titles that contain digits", () => {
    expect(parseMovieName("Dune Part Two 2024 2160p HDR")).toEqual({
      title: "Dune Part Two",
      year: 2024,
    });
  });

  it("returns a bare title when no year is present", () => {
    expect(parseMovieName("Amélie")).toEqual({ title: "Amélie" });
  });

  it("drops bracketed release groups and checksums", () => {
    expect(parseMovieName("Arrival (2016) [1080p] {ABCD1234}")).toEqual({
      title: "Arrival",
      year: 2016,
    });
  });

  it("does not truncate a title whose only token looks like metadata", () => {
    expect(parseMovieName("Ma (2019)")).toEqual({ title: "Ma", year: 2019 });
    expect(parseMovieName("Us.2019.1080p")).toEqual({
      title: "Us",
      year: 2019,
    });
  });
});

describe("parseSeasonFolder", () => {
  it.each([
    ["Season 01", 1],
    ["Season 2", 2],
    ["season.03", 3],
    ["S04", 4],
    ["Sezon 5", 5],
    ["Specials", 0],
    ["Season 0", 0],
  ])("reads %s as season %i", (name, expected) => {
    expect(parseSeasonFolder(name)).toBe(expected);
  });

  it("returns undefined for folders that are not seasons", () => {
    expect(parseSeasonFolder("Extras")).toBeUndefined();
    expect(parseSeasonFolder("Breaking Bad")).toBeUndefined();
  });
});

describe("parseEpisodeName", () => {
  it("reads the canonical S01E02 form with an episode title", () => {
    expect(
      parseEpisodeName("Breaking Bad - S01E02 - Cat's in the Bag", {}),
    ).toMatchObject({
      seriesTitle: "Breaking Bad",
      seasonNumber: 1,
      episodeNumber: 2,
      episodeTitle: "Cat's in the Bag",
      title: "Cat's in the Bag",
    });
  });

  it("reads scene style with release metadata", () => {
    expect(
      parseEpisodeName("The.Wire.S03E07.Back.Burners.1080p.WEB-DL.x264"),
    ).toMatchObject({
      seriesTitle: "The Wire",
      seasonNumber: 3,
      episodeNumber: 7,
      episodeTitle: "Back Burners",
    });
  });

  it("reads the 1x02 form", () => {
    expect(parseEpisodeName("Firefly 1x02 The Train Job")).toMatchObject({
      seriesTitle: "Firefly",
      seasonNumber: 1,
      episodeNumber: 2,
      episodeTitle: "The Train Job",
    });
  });

  it("reads a multi-episode range", () => {
    expect(parseEpisodeName("Show - S02E05-E06 - Double")).toMatchObject({
      seasonNumber: 2,
      episodeNumber: 5,
      endEpisodeNumber: 6,
    });
    expect(parseEpisodeName("Show.S02E05E06")).toMatchObject({
      episodeNumber: 5,
      endEpisodeNumber: 6,
    });
  });

  it("falls back to folder context when the name omits the season", () => {
    expect(
      parseEpisodeName("Episode 4 - The Gathering", {
        folderSeasonNumber: 2,
        folderSeriesTitle: "Babylon 5",
      }),
    ).toMatchObject({
      seriesTitle: "Babylon 5",
      seasonNumber: 2,
      episodeNumber: 4,
    });
  });

  it("prefers the folder series title over the one embedded in the file", () => {
    expect(
      parseEpisodeName("wrongname.S01E01.Pilot", {
        folderSeriesTitle: "Correct Series",
      }),
    ).toMatchObject({ seriesTitle: "Correct Series", episodeNumber: 1 });
  });

  it("names an episode by number when it carries no title", () => {
    expect(parseEpisodeName("Show.S01E09.1080p.WEB")).toMatchObject({
      episodeNumber: 9,
      title: "Episode 9",
    });
  });

  it("does not invent episode numbers for an unparseable name", () => {
    const parsed = parseEpisodeName("Some Documentary (2020)");
    expect(parsed.episodeNumber).toBeUndefined();
    expect(parsed.title).toBe("Some Documentary");
  });
});

describe("file classification", () => {
  it("splits extensions", () => {
    expect(splitExtension("movie.mkv")).toEqual({
      stem: "movie",
      extension: "mkv",
    });
    expect(splitExtension(".hidden")).toEqual({
      stem: ".hidden",
      extension: "",
    });
  });

  it("ignores hidden and platform sidecar entries", () => {
    expect(isIgnoredEntry(".seyirlik")).toBe(true);
    expect(isIgnoredEntry("Thumbs.db")).toBe(true);
    expect(isIgnoredEntry("Movies")).toBe(false);
  });

  it("recognizes extras folders and trailer files", () => {
    expect(isExtraDirectory("Extras")).toBe(true);
    expect(isExtraDirectory("behind the scenes")).toBe(true);
    expect(isExtraDirectory("Season 01")).toBe(false);
    // Media managers write video backdrops and theme clips beside a title;
    // these hold real .mp4 files and would otherwise scan as separate movies.
    expect(isExtraDirectory("Backdrops")).toBe(true);
    expect(isExtraDirectory("extrafanart")).toBe(true);
    expect(isTrailerFile("The Matrix-trailer")).toBe(true);
    expect(isTrailerFile("The Trailer Park Boys")).toBe(false);
  });
});

describe("parseSubtitleSuffix", () => {
  it("reads language and flags", () => {
    expect(parseSubtitleSuffix("Movie.en.forced")).toEqual({
      baseStem: "Movie",
      language: "en",
      isForced: true,
      isDefault: false,
    });
    expect(parseSubtitleSuffix("Movie.tur.sdh")).toEqual({
      baseStem: "Movie",
      language: "tur",
      isForced: false,
      isDefault: false,
    });
  });

  it("leaves a stem without a language suffix untouched", () => {
    expect(parseSubtitleSuffix("Movie")).toEqual({
      baseStem: "Movie",
      isForced: false,
      isDefault: false,
    });
  });
});

describe("buildSortTitle", () => {
  it("drops leading articles and diacritics", () => {
    expect(buildSortTitle("The Matrix")).toBe("matrix");
    expect(buildSortTitle("Amélie")).toBe("amelie");
    expect(buildSortTitle("A Quiet Place")).toBe("quiet place");
  });
});
