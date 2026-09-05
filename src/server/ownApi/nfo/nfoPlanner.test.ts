import { describe, expect, it } from "vitest";
import { planNfoFiles } from "./nfoPlanner";
import type {
  NfoFileRow,
  NfoItemBundle,
  NfoItemRow,
  NfoPersonRow,
  NfoStreamRow,
} from "./nfoRepository";

function item(overrides: Partial<NfoItemRow> = {}): NfoItemRow {
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    libraryId: "bbbbbbbb-2222-4222-8222-222222222222",
    parentId: null,
    seriesId: null,
    kind: "movie",
    sourceKey: "movie:movies/dune (2021)",
    title: "Dune",
    sortTitle: "dune",
    originalTitle: null,
    overview: null,
    tagline: null,
    productionYear: null,
    premiereDate: null,
    endDate: null,
    officialRating: null,
    communityRating: null,
    runtimeMs: null,
    indexNumber: null,
    parentIndexNumber: null,
    providerIds: {},
    ...overrides,
  };
}

function file(overrides: Partial<NfoFileRow> = {}): NfoFileRow {
  return {
    id: "cccccccc-3333-4333-8333-333333333333",
    itemId: "aaaaaaaa-1111-4111-8111-111111111111",
    relativePath: "Movies/Dune (2021)/Dune (2021).mkv",
    container: "mkv",
    durationMs: null,
    isPrimary: true,
    ...overrides,
  };
}

function bundle(overrides: Partial<NfoItemBundle> = {}): NfoItemBundle {
  return {
    item: item(),
    files: [file()],
    streams: [],
    genres: [],
    people: [],
    ...overrides,
  };
}

function person(overrides: Partial<NfoPersonRow> = {}): NfoPersonRow {
  return {
    itemId: "aaaaaaaa-1111-4111-8111-111111111111",
    name: "Denis Villeneuve",
    role: "director",
    characterName: null,
    sortOrder: 0,
    providerIds: {},
    ...overrides,
  };
}

function paths(plan: ReturnType<typeof planNfoFiles>): string[] {
  return plan.files.map((planned) => planned.relativePath);
}

describe("nfo planner", () => {
  describe("movie layout", () => {
    it("writes movie.nfo in the title folder", () => {
      const plan = planNfoFiles(bundle());

      expect(paths(plan)).toEqual(["Movies/Dune (2021)/movie.nfo"]);
      expect(plan.files[0]?.xml).toContain("<movie>");
    });

    it("takes the folder's real casing from the file path, not the source key", () => {
      // Source keys are lower-cased for matching; using one as a path would
      // write beside the real folder rather than into it.
      const plan = planNfoFiles(
        bundle({
          item: item({ sourceKey: "movie:movies/dune (2021)" }),
          files: [file({ relativePath: "Movies/Dune (2021)/Dune.mkv" })],
        }),
      );

      expect(paths(plan)[0]).toBe("Movies/Dune (2021)/movie.nfo");
    });

    it("skips a movie whose path does not sit under its own source key", () => {
      const plan = planNfoFiles(
        bundle({ files: [file({ relativePath: "Other/Elsewhere.mkv" })] }),
      );

      expect(plan.files).toHaveLength(0);
      expect(plan.skipped).toBe("no-title-root");
    });

    it("skips a movie with no file left on disk", () => {
      const plan = planNfoFiles(bundle({ files: [] }));

      expect(plan.skipped).toBe("no-primary-file");
    });
  });

  describe("multi-version layout", () => {
    const versions = bundle({
      files: [
        file({
          id: "11111111-1111-4111-8111-111111111111",
          relativePath: "Movies/Dune (2021)/Dune (2021) - 2160p.mkv",
        }),
        file({
          id: "22222222-2222-4222-8222-222222222222",
          relativePath: "Movies/Dune (2021)/Dune (2021) - 1080p.mkv",
          isPrimary: false,
        }),
      ],
      streams: [
        stream({
          mediaFileId: "11111111-1111-4111-8111-111111111111",
          width: 3840,
          height: 2160,
        }),
        stream({
          mediaFileId: "22222222-2222-4222-8222-222222222222",
          width: 1920,
          height: 1080,
        }),
      ],
    });

    it("keeps movie.nfo and adds one file per version", () => {
      expect(paths(planNfoFiles(versions)).sort()).toEqual([
        "Movies/Dune (2021)/Dune (2021) - 1080p.mkv".replace(".mkv", ".nfo"),
        "Movies/Dune (2021)/Dune (2021) - 2160p.nfo",
        "Movies/Dune (2021)/movie.nfo",
      ]);
    });

    it("describes each version with its own technical detail", () => {
      const plan = planNfoFiles(versions);
      const uhd = plan.files.find((planned) =>
        planned.relativePath.endsWith("2160p.nfo"),
      );
      const hd = plan.files.find((planned) =>
        planned.relativePath.endsWith("1080p.nfo"),
      );

      expect(uhd?.xml).toContain("<width>3840</width>");
      expect(hd?.xml).toContain("<width>1920</width>");
      // The folder-level file describes the primary version.
      expect(
        plan.files.find((planned) => planned.relativePath.endsWith("movie.nfo"))
          ?.xml,
      ).toContain("<width>3840</width>");
    });

    it("never plans the same path twice", () => {
      const plan = planNfoFiles(
        bundle({
          files: [
            file({ relativePath: "Movies/Dune (2021)/movie.mkv" }),
            file({
              id: "22222222-2222-4222-8222-222222222222",
              relativePath: "Movies/Dune (2021)/movie 4k.mkv",
              isPrimary: false,
            }),
          ],
        }),
      );

      expect(new Set(paths(plan)).size).toBe(plan.files.length);
    });
  });

  describe("series layout", () => {
    const series = bundle({
      item: item({
        kind: "series",
        sourceKey: "series:series/şahsiyet",
        title: "Şahsiyet",
        endDate: new Date("2018-05-25T00:00:00Z"),
      }),
      files: [],
      descendantRelativePath: "Series/Şahsiyet/Season 01/S01E01.mkv",
    });

    it("writes tvshow.nfo in the series folder, found through an episode", () => {
      const plan = planNfoFiles(series);

      expect(paths(plan)).toEqual(["Series/Şahsiyet/tvshow.nfo"]);
      expect(plan.files[0]?.xml).toContain("<tvshow>");
    });

    it("carries the end date a finished show has", () => {
      expect(planNfoFiles(series).files[0]?.xml).toContain(
        "<enddate>2018-05-25</enddate>",
      );
    });

    it("skips a series with nothing beneath it", () => {
      const plan = planNfoFiles({ ...series, descendantRelativePath: null });
      expect(plan.skipped).toBe("no-title-root");
    });
  });

  describe("season layout", () => {
    const season = bundle({
      item: item({
        kind: "season",
        sourceKey: "season:series:series/şahsiyet:1",
        title: "Season 1",
        indexNumber: 1,
      }),
      files: [],
      seriesTitleRoot: "Series/Şahsiyet",
      seasonEpisodeDirectories: ["Series/Şahsiyet/Season 01"],
    });

    it("writes season.nfo in the season folder", () => {
      const plan = planNfoFiles(season);

      expect(paths(plan)).toEqual(["Series/Şahsiyet/Season 01/season.nfo"]);
      expect(plan.files[0]?.xml).toContain("<seasonnumber>1</seasonnumber>");
    });

    it("refuses a flat series, where season.nfo would describe every season", () => {
      const plan = planNfoFiles({
        ...season,
        seasonEpisodeDirectories: ["Series/Şahsiyet"],
      });

      expect(plan.files).toHaveLength(0);
      expect(plan.skipped).toBe("no-season-directory");
    });

    it("refuses a season split across folders rather than guessing one", () => {
      const plan = planNfoFiles({
        ...season,
        seasonEpisodeDirectories: [
          "Series/Şahsiyet/Season 01",
          "Series/Şahsiyet/Season 01 Extras",
        ],
      });

      expect(plan.skipped).toBe("no-season-directory");
    });
  });

  describe("episode layout", () => {
    const episode = bundle({
      item: item({
        kind: "episode",
        sourceKey: "episode:series:series/şahsiyet:1:1",
        title: "Birinci Bölüm",
        indexNumber: 1,
        parentIndexNumber: 1,
        premiereDate: new Date("2018-03-09T00:00:00Z"),
      }),
      files: [file({ relativePath: "Series/Şahsiyet/Season 01/S01E01.mkv" })],
      seriesTitle: "Şahsiyet",
    });

    /*
     * The episode's own folder — the one its renditions are published into —
     * rather than loose in a season folder shared with every other episode.
     */
    it("puts the file in the episode's own folder", () => {
      const plan = planNfoFiles(episode);

      expect(paths(plan)).toEqual([
        "Series/Şahsiyet/Season 01/S01E01/S01E01.nfo",
      ]);
    });

    it("finds that folder from a source kept in the src/ bucket", () => {
      const plan = planNfoFiles({
        ...episode,
        files: [
          file({ relativePath: "Series/Şahsiyet/Season 01/src/S01E01.mkv" }),
        ],
      });

      expect(paths(plan)).toEqual([
        "Series/Şahsiyet/Season 01/S01E01/S01E01.nfo",
      ]);
    });

    it("carries showtitle, season, episode and aired", () => {
      const xml = planNfoFiles(episode).files[0]?.xml ?? "";

      expect(xml).toContain("<episodedetails>");
      expect(xml).toContain("<showtitle>Şahsiyet</showtitle>");
      expect(xml).toContain("<season>1</season>");
      expect(xml).toContain("<episode>1</episode>");
      expect(xml).toContain("<aired>2018-03-09</aired>");
      // An episode's date is `aired`; `premiered` belongs to the show.
      expect(xml).not.toContain("<premiered>");
    });

    it("gives each alternate cut its own file", () => {
      const plan = planNfoFiles({
        ...episode,
        files: [
          file({ relativePath: "Series/Şahsiyet/Season 01/S01E01.mkv" }),
          file({
            id: "44444444-4444-4444-8444-444444444444",
            relativePath: "Series/Şahsiyet/Season 01/S01E01 - extended.mkv",
            isPrimary: false,
          }),
        ],
      });

      // Both in the one episode folder: an alternate cut is another file of
      // the same episode, not an episode of its own.
      expect(paths(plan).sort()).toEqual([
        "Series/Şahsiyet/Season 01/S01E01/S01E01 - extended.nfo",
        "Series/Şahsiyet/Season 01/S01E01/S01E01.nfo",
      ]);
    });
  });

  describe("missing metadata", () => {
    it("produces a valid file from nothing but a title and a path", () => {
      const xml = planNfoFiles(bundle()).files[0]?.xml ?? "";

      expect(xml).toContain("<title>Dune</title>");
      expect(xml).not.toContain("<plot>");
      expect(xml).not.toContain("<uniqueid");
      expect(xml).not.toContain("<fileinfo>");
    });

    it("omits a sort title that only repeats the title", () => {
      const same = planNfoFiles(
        bundle({ item: item({ title: "Dune", sortTitle: "Dune" }) }),
      );
      const different = planNfoFiles(
        bundle({ item: item({ title: "The Dune", sortTitle: "Dune, The" }) }),
      );

      expect(same.files[0]?.xml).not.toContain("<sorttitle>");
      expect(different.files[0]?.xml).toContain(
        "<sorttitle>Dune, The</sorttitle>",
      );
    });

    it("drops a runtime of zero rather than claiming a zero-minute film", () => {
      expect(
        planNfoFiles(bundle({ item: item({ runtimeMs: "0" }) })).files[0]?.xml,
      ).not.toContain("<runtime>");
    });

    it("converts a millisecond runtime to whole minutes", () => {
      expect(
        planNfoFiles(bundle({ item: item({ runtimeMs: "9180000" }) })).files[0]
          ?.xml,
      ).toContain("<runtime>153</runtime>");
    });
  });

  describe("people and genres", () => {
    it("orders by sort order and separates the roles", () => {
      const xml =
        planNfoFiles(
          bundle({
            genres: [
              { itemId: "x", name: "Adventure", sortOrder: 1 },
              { itemId: "x", name: "Science Fiction", sortOrder: 0 },
            ],
            people: [
              person({ name: "Denis Villeneuve", role: "director" }),
              person({ name: "Jon Spaihts", role: "writer" }),
              person({
                name: "Rebecca Ferguson",
                role: "actor",
                characterName: "Lady Jessica",
                sortOrder: 1,
              }),
              person({
                name: "Timothée Chalamet",
                role: "actor",
                characterName: "Paul Atreides",
                sortOrder: 0,
                providerIds: { tmdb: "1190668" },
              }),
            ],
          }),
        ).files[0]?.xml ?? "";

      expect(xml.indexOf("Science Fiction")).toBeLessThan(
        xml.indexOf("Adventure"),
      );
      expect(xml).toContain("<director>Denis Villeneuve</director>");
      expect(xml).toContain("<credits>Jon Spaihts</credits>");
      expect(xml.indexOf("Timothée Chalamet")).toBeLessThan(
        xml.indexOf("Rebecca Ferguson"),
      );
      expect(xml).toContain("<role>Paul Atreides</role>");
      expect(xml).toContain("<order>0</order>");
      expect(xml).toContain("<tmdbid>1190668</tmdbid>");
    });
  });

  describe("technical detail", () => {
    it("serializes video, audio and subtitle streams in index order", () => {
      const xml =
        planNfoFiles(
          bundle({
            files: [file({ durationMs: "9180000" })],
            streams: [
              stream({ streamIndex: 0, kind: "video", codec: "hevc" }),
              stream({
                streamIndex: 1,
                kind: "audio",
                codec: "eac3",
                language: "tur",
                channels: 6,
              }),
              stream({
                streamIndex: 2,
                kind: "subtitle",
                codec: "subrip",
                language: "eng",
                isDefault: false,
                isForced: true,
              }),
            ],
          }),
        ).files[0]?.xml ?? "";

      expect(xml).toContain("<streamdetails>");
      expect(xml).toContain("<codec>hevc</codec>");
      expect(xml).toContain("<durationinseconds>9180</durationinseconds>");
      expect(xml).toContain("<channels>6</channels>");
      expect(xml).toContain("<language>eng</language>");
      expect(xml.indexOf("<video>")).toBeLessThan(xml.indexOf("<audio>"));
      expect(xml.indexOf("<audio>")).toBeLessThan(xml.indexOf("<subtitle>"));
    });

    it("reports HDR but not SDR, which is the absence of a range", () => {
      const hdr =
        planNfoFiles(
          bundle({ streams: [stream({ videoRange: "HDR10", bitDepth: 10 })] }),
        ).files[0]?.xml ?? "";
      const sdr =
        planNfoFiles(bundle({ streams: [stream({ videoRange: "SDR" })] }))
          .files[0]?.xml ?? "";

      expect(hdr).toContain("<hdrtype>hdr10</hdrtype>");
      expect(hdr).toContain("<bitdepth>10</bitdepth>");
      expect(sdr).not.toContain("<hdrtype>");
    });

    it("computes the aspect ratio from the recorded dimensions", () => {
      expect(
        planNfoFiles(
          bundle({ streams: [stream({ width: 1920, height: 1080 })] }),
        ).files[0]?.xml,
      ).toContain("<aspect>1.778</aspect>");
    });

    it("ignores streams belonging to another file", () => {
      const xml =
        planNfoFiles(
          bundle({
            streams: [
              stream({ mediaFileId: "99999999-9999-4999-8999-999999999999" }),
            ],
          }),
        ).files[0]?.xml ?? "";

      expect(xml).not.toContain("<fileinfo>");
    });
  });

  describe("idempotency", () => {
    it("produces identical bytes when nothing in the catalogue changed", () => {
      const input = bundle({
        item: item({
          originalTitle: "Dune",
          overview: "Paul Atreides arrives on Arrakis.",
          productionYear: 2021,
          premiereDate: new Date("2021-09-15T00:00:00Z"),
          communityRating: 7.79999995231628,
          officialRating: "PG-13",
          runtimeMs: "9180000",
          providerIds: { tmdb: "438631", imdb: "tt1160419" },
        }),
        genres: [{ itemId: "x", name: "Science Fiction", sortOrder: 0 }],
        people: [person()],
        streams: [stream()],
      });

      const first = planNfoFiles(input);
      const second = planNfoFiles(structuredClone(input));

      expect(second.files.map((f) => f.relativePath)).toEqual(
        first.files.map((f) => f.relativePath),
      );
      expect(second.files.map((f) => f.xml)).toEqual(
        first.files.map((f) => f.xml),
      );
    });

    it("does not depend on the order provider ids arrive in", () => {
      const forward = planNfoFiles(
        bundle({
          item: item({ providerIds: { tmdb: "1", imdb: "tt2", tvdb: "3" } }),
        }),
      );
      const reversed = planNfoFiles(
        bundle({
          item: item({ providerIds: { tvdb: "3", imdb: "tt2", tmdb: "1" } }),
        }),
      );

      expect(reversed.files[0]?.xml).toBe(forward.files[0]?.xml);
    });
  });

  it("plans nothing for a kind that owns no .nfo", () => {
    const plan = planNfoFiles(
      bundle({
        item: item({ kind: "book", sourceKey: "book:books/dune.epub" }),
      }),
    );

    expect(plan.files).toHaveLength(0);
    expect(plan.skipped).toBe("unsupported-kind");
  });
});

function stream(overrides: Partial<NfoStreamRow> = {}): NfoStreamRow {
  return {
    mediaFileId: "cccccccc-3333-4333-8333-333333333333",
    streamIndex: 0,
    kind: "video",
    codec: "hevc",
    language: null,
    isDefault: true,
    isForced: false,
    channels: null,
    width: null,
    height: null,
    bitDepth: null,
    videoRange: null,
    ...overrides,
  };
}
