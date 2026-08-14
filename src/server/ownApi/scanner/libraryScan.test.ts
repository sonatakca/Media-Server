import { describe, expect, it } from "vitest";
import {
  scanLibraryTree,
  type ScannedItem,
  type ScannerFileSystem,
} from "./libraryScan";

/**
 * Tree fixture: keys are directory paths relative to the media root, values are
 * their entries. A trailing "/" marks a directory entry.
 */
function createFileSystem(
  tree: Record<string, string[]>,
  sizes: Record<string, number> = {},
): ScannerFileSystem {
  return {
    readDirectory: async (relativePath) => {
      const entries = tree[relativePath];
      if (!entries) throw new Error(`missing directory ${relativePath}`);
      return entries.map((entry) => ({
        name: entry.replace(/\/$/, ""),
        isDirectory: entry.endsWith("/"),
      }));
    },
    statFile: async (relativePath) => ({
      size: sizes[relativePath] ?? 1_000,
      mtimeMs: 1_700_000_000_000,
    }),
  };
}

function byKind(items: ScannedItem[], kind: string): ScannedItem[] {
  return items.filter((item) => item.kind === kind);
}

describe("scanLibraryTree — movies", () => {
  it("treats a title folder as one movie and picks the largest file first", async () => {
    const fileSystem = createFileSystem(
      {
        Movies: ["The Matrix (1999)/"],
        "Movies/The Matrix (1999)": [
          "The Matrix (1999) - 2160p.mkv",
          "The Matrix (1999) - 1080p.mkv",
          "The Matrix (1999).en.srt",
        ],
      },
      {
        "Movies/The Matrix (1999)/The Matrix (1999) - 2160p.mkv": 60_000,
        "Movies/The Matrix (1999)/The Matrix (1999) - 1080p.mkv": 10_000,
      },
    );

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    const movies = byKind(result.items, "movie");
    expect(movies).toHaveLength(1);
    expect(movies[0]).toMatchObject({ title: "The Matrix", year: 1999 });
    expect(movies[0]?.files.map((file) => file.relativePath)).toEqual([
      "Movies/The Matrix (1999)/The Matrix (1999) - 2160p.mkv",
      "Movies/The Matrix (1999)/The Matrix (1999) - 1080p.mkv",
    ]);
  });

  it("describes a matching Turkish SRT as an external text stream", async () => {
    const result = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Ford v Ferrari (2019)/"],
        "Movies/Ford v Ferrari (2019)": [
          "Ford v Ferrari (2019) [359724].mp4",
          "Ford v Ferrari (2019) [359724].tr.srt",
        ],
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")[0]?.subtitles).toEqual([
      {
        relativePath:
          "Movies/Ford v Ferrari (2019)/Ford v Ferrari (2019) [359724].tr.srt",
        codec: "subrip",
        isText: true,
        language: "tr",
        isForced: false,
        isDefault: false,
      },
    ]);
  });

  it("does not merge different titles that share a folder", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Boxset/"],
      "Movies/Boxset": ["Alien (1979).mkv", "Aliens (1986).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(
      byKind(result.items, "movie")
        .map((item) => item.title)
        .sort(),
    ).toEqual(["Alien", "Aliens"]);
  });

  it("treats each loose file at the library root as its own movie", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Arrival (2016).mkv", "Sicario (2015).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(2);
  });

  it("attaches trailers to their movie and skips extras and samples", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Dune (2021)/"],
      "Movies/Dune (2021)": [
        "Dune (2021).mkv",
        "Dune-trailer.mkv",
        "sample.mkv",
        "Extras/",
      ],
      "Movies/Dune (2021)/Extras": ["Behind the scenes.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(1);
    const trailers = byKind(result.items, "trailer");
    expect(trailers).toHaveLength(1);
    expect(trailers[0]?.parentSourceKey).toBe(
      byKind(result.items, "movie")[0]?.sourceKey,
    );
    expect(result.skipped.some((skip) => skip.reason === "sample")).toBe(true);
  });

  it("keeps identifiers stable when a file is re-encoded into another container", async () => {
    const before = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Heat (1995)/"],
        "Movies/Heat (1995)": ["Heat (1995).avi"],
      }),
      rootPath: "Movies",
      kind: "movies",
    });
    const after = await scanLibraryTree({
      fileSystem: createFileSystem({
        Movies: ["Heat (1995)/"],
        "Movies/Heat (1995)": ["Heat (1995).mkv"],
      }),
      rootPath: "Movies",
      kind: "movies",
    });

    expect(before.items[0]?.sourceKey).toBe(after.items[0]?.sourceKey);
  });
});

describe("scanLibraryTree — series", () => {
  it("builds series, seasons and episodes from season folders", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Breaking Bad (2008)/"],
      "Shows/Breaking Bad (2008)": ["Season 01/", "Season 02/", "Extras/"],
      "Shows/Breaking Bad (2008)/Season 01": [
        "Breaking Bad - S01E01 - Pilot.mkv",
        "Breaking Bad - S01E02 - Cat's in the Bag.mkv",
      ],
      "Shows/Breaking Bad (2008)/Season 02": [
        "Breaking Bad - S02E01 - Seven Thirty-Seven.mkv",
      ],
      "Shows/Breaking Bad (2008)/Extras": ["Blooper.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const series = byKind(result.items, "series");
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ title: "Breaking Bad", year: 2008 });

    const seasons = byKind(result.items, "season");
    expect(seasons.map((season) => season.indexNumber).sort()).toEqual([1, 2]);

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(3);
    expect(episodes[0]).toMatchObject({
      title: "Pilot",
      indexNumber: 1,
      parentIndexNumber: 1,
      seriesSourceKey: series[0]?.sourceKey,
    });
  });

  it("infers the season from the folder when the filename omits it", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Babylon 5/"],
      "Shows/Babylon 5": ["Season 3/"],
      "Shows/Babylon 5/Season 3": ["Episode 04 - Passing Through.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(byKind(result.items, "episode")[0]).toMatchObject({
      parentIndexNumber: 3,
      indexNumber: 4,
    });
  });

  it("handles a flat series folder with no season directories", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Firefly/"],
      "Shows/Firefly": [
        "Firefly 1x01 Serenity.mkv",
        "Firefly 1x02 The Train Job.mkv",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(byKind(result.items, "season")).toHaveLength(1);
    expect(byKind(result.items, "episode")).toHaveLength(2);
  });

  it("files specials as season zero", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Show/"],
      "Shows/Show": ["Specials/"],
      "Shows/Show/Specials": ["Show - S00E01 - Christmas.mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(byKind(result.items, "season")[0]).toMatchObject({
      indexNumber: 0,
      title: "Specials",
    });
  });

  it("drops a folder that contains no playable episodes", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Empty Show/"],
      "Shows/Empty Show": ["readme.txt"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    expect(result.items).toHaveLength(0);
  });

  it("keeps a second file for the same episode as an alternate cut", async () => {
    const fileSystem = createFileSystem({
      Shows: ["Show/"],
      "Shows/Show": ["Season 01/"],
      "Shows/Show/Season 01": [
        "Show - S01E01 - Pilot - 1080p.mkv",
        "Show - S01E01 - Pilot - 2160p.mkv",
      ],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Shows",
      kind: "series",
    });

    const episodes = byKind(result.items, "episode");
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.files).toHaveLength(2);
  });
});

describe("scanLibraryTree — books and mixed roots", () => {
  it("catalogues book files recursively", async () => {
    const fileSystem = createFileSystem({
      Books: ["Fiction/", "Loose Book.epub"],
      "Books/Fiction": ["Dune (1965).epub", "cover.jpg"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Books",
      kind: "books",
    });

    expect(
      byKind(result.items, "book")
        .map((item) => item.title)
        .sort(),
    ).toEqual(["Dune", "Loose Book"]);
  });

  it("classifies a mixed root by the presence of season folders", async () => {
    const fileSystem = createFileSystem({
      Media: ["Some Show/", "Some Movie (2020)/", "Loose (2011).mkv"],
      "Media/Some Show": ["Season 01/"],
      "Media/Some Show/Season 01": ["Some Show - S01E01.mkv"],
      "Media/Some Movie (2020)": ["Some Movie (2020).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Media",
      kind: "mixed",
    });

    expect(byKind(result.items, "series")).toHaveLength(1);
    expect(byKind(result.items, "episode")).toHaveLength(1);
    expect(
      byKind(result.items, "movie")
        .map((item) => item.title)
        .sort(),
    ).toEqual(["Loose", "Some Movie"]);
  });

  it("records unreadable directories instead of failing the whole scan", async () => {
    const fileSystem = createFileSystem({
      Movies: ["Good (2020)/", "Broken/"],
      "Movies/Good (2020)": ["Good (2020).mkv"],
    });

    const result = await scanLibraryTree({
      fileSystem,
      rootPath: "Movies",
      kind: "movies",
    });

    expect(byKind(result.items, "movie")).toHaveLength(1);
    expect(result.skipped).toContainEqual({
      relativePath: "Movies/Broken",
      reason: "unreadable",
    });
  });
});
