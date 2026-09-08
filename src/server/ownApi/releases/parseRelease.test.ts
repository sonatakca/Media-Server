// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseRelease } from "./parseRelease";

describe("reading a movie release title", () => {
  it("reads a full 2160p web release", () => {
    const facts = parseRelease(
      "Blade.Runner.2049.2017.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-MZABI",
    );
    expect(facts).toMatchObject({
      kind: "movie",
      normalizedTitle: "blade runner 2049",
      year: 2017,
      resolution: "2160p",
      source: "webdl",
      videoCodec: "hevc",
      audioCodec: "eac3",
      audioChannels: 6,
      releaseGroup: "MZABI",
      streamingService: "Amazon",
    });
  });

  it("keeps a title that ends in numbers out of the year", () => {
    /*
     * "Blade Runner 2049" and "2012" are film names whose last token looks
     * exactly like a year. The year is the last plausible one *before* the
     * metadata starts, which is why reading left to right gets this wrong.
     */
    expect(parseRelease("2012.2009.1080p.BluRay.x264-GROUP")).toMatchObject({
      normalizedTitle: "2012",
      year: 2009,
    });
    expect(parseRelease("Blade.Runner.2049.2017.1080p.BluRay-XYZ").year).toBe(
      2017,
    );
  });

  it("tells a remux apart from an ordinary disc rip", () => {
    expect(
      parseRelease(
        "Dune.2021.UHD.BluRay.2160p.TrueHD.Atmos.7.1.HEVC.REMUX-FraMeSToR",
      ),
    ).toMatchObject({
      source: "remux",
      resolution: "2160p",
      audioCodec: "truehd",
      audioChannels: 8,
      audioFeatures: ["Atmos"],
      releaseGroup: "FraMeSToR",
    });
    expect(parseRelease("Dune.2021.1080p.BluRay.x264-GROUP").source).toBe(
      "bluray",
    );
  });

  it("reads Dolby Vision alongside HDR10 rather than picking one", () => {
    const facts = parseRelease(
      "Blade Runner 2049.2017.2160p.UHD.BluRay.HDR.DoVi.TrueHD 7.1.Atmos.x265-TERMiNAL",
    );
    expect(facts.hdr).toEqual(["dolbyvision"]);
    const both = parseRelease("Film.2020.2160p.WEB-DL.DV.HDR10+.HEVC-X");
    expect(both.hdr).toEqual(["hdr10plus", "dolbyvision"]);
  });

  it.each([
    ["Movie.2020.2160p.WEB-DL.HDR10.HEVC-X", ["hdr10"]],
    ["Movie.2020.2160p.WEB-DL.HLG.HEVC-X", ["hlg"]],
    ["Movie.2020.1080p.WEB-DL.SDR.H264-X", ["sdr"]],
  ])("reads the HDR the title actually claims in %s", (title, expected) => {
    expect(parseRelease(title).hdr).toEqual(expected);
  });

  it("believes an explicit line count over a loose UHD", () => {
    /*
     * Found in live results: "Hybrid.1080p.UHD.BluRay" is a 1080p encode from
     * a UHD source. Reading it as 2160p offered it to a profile that had asked
     * for 4K.
     */
    expect(
      parseRelease("Movie.2017.Hybrid.1080p.UHD.BluRay.DDP7.1-G").resolution,
    ).toBe("1080p");
    expect(parseRelease("Movie.2017.UHD.BluRay.TrueHD-G").resolution).toBe(
      "2160p",
    );
    expect(parseRelease("Movie.2017.4K.WEB-DL-G").resolution).toBe("2160p");
    expect(parseRelease("Movie.2017.2160p.UHD.BluRay-G").resolution).toBe(
      "2160p",
    );
  });

  it("says nothing about HDR when the title says nothing", () => {
    // Not SDR. A fact invented here is one no later layer can tell from a real
    // one, and "the release did not say" is a different thing from "it is SDR".
    expect(parseRelease("Movie.2020.1080p.BluRay.x264-GRP").hdr).toEqual([]);
  });

  it.each([
    ["Movie.2020.Extended.1080p.BluRay-X", "Extended"],
    ["Movie.2020.Directors.Cut.1080p.BluRay-X", "Director's Cut"],
    ["Movie.2020.IMAX.2160p.WEB-DL-X", "IMAX"],
    ["Movie.2020.Theatrical.Cut.1080p-X", "Theatrical"],
    ["Movie.2020.REMASTERED.1080p.BluRay-X", "Remastered"],
    ["Movie.2020.Criterion.1080p.BluRay-X", "Criterion"],
  ])("reads the edition in %s", (title, edition) => {
    expect(parseRelease(title).edition).toContain(edition);
  });

  it.each([
    ["Movie.2020.1080p.BluRay.x264-GRP", "avc"],
    ["Movie.2020.1080p.BluRay.H.264-GRP", "avc"],
    ["Movie.2020.2160p.WEB.x265-GRP", "hevc"],
    ["Movie.2020.2160p.WEB.H265-GRP", "hevc"],
    ["Movie.2020.2160p.WEB.HEVC-GRP", "hevc"],
    ["Movie.2020.2160p.WEB.AV1-GRP", "av1"],
    ["Movie.2003.1080p.BluRay.VC-1-GRP", "vc1"],
    ["Movie.1999.DVDRip.XviD-GRP", "xvid"],
  ])("reads the codec in %s", (title, codec) => {
    expect(parseRelease(title).videoCodec).toBe(codec);
  });

  it.each([
    ["Movie.2020.1080p.WEB-DL.DDP5.1-GRP", "eac3"],
    ["Movie.2020.1080p.BluRay.DTS-HD.MA.5.1-GRP", "dtshd"],
    ["Movie.2020.2160p.BluRay.DTS-X.7.1-GRP", "dtsx"],
    ["Movie.2020.1080p.BluRay.TrueHD.7.1-GRP", "truehd"],
    ["Movie.2020.1080p.BluRay.AC3-GRP", "ac3"],
    ["Movie.2020.1080p.WEB.AAC2.0-GRP", "aac"],
    ["Movie.2020.1080p.BluRay.FLAC-GRP", "flac"],
  ])("reads the audio codec in %s", (title, codec) => {
    expect(parseRelease(title).audioCodec).toBe(codec);
  });

  it("prefers the more specific audio token", () => {
    // "DTS-HD MA" must not be recorded as plain DTS.
    expect(parseRelease("M.2020.1080p.BluRay.DTS-HD.MA.7.1-G").audioCodec).toBe(
      "dtshd",
    );
  });

  it.each([
    ["Movie.2020.PROPER.1080p.BluRay-GRP", { proper: true, revision: 1 }],
    ["Movie.2020.REPACK.1080p.BluRay-GRP", { repack: true, revision: 1 }],
    ["Movie.2020.REPACK2.1080p.BluRay-GRP", { repack: true, revision: 2 }],
    ["Movie.2020.REAL.PROPER.1080p-GRP", { real: true, proper: true }],
    ["Movie.2020.iNTERNAL.1080p.BluRay-GRP", { internal: true }],
  ])("reads the revision markers in %s", (title, expected) => {
    expect(parseRelease(title)).toMatchObject(expected);
  });
});

describe("reading a television release title", () => {
  it("reads a single episode", () => {
    expect(
      parseRelease("The.Expanse.S05E03.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb"),
    ).toMatchObject({
      kind: "episode",
      normalizedTitle: "the expanse",
      episodeRanges: [{ season: 5, episodes: [3] }],
      isSeasonPack: false,
      resolution: "1080p",
      releaseGroup: "NTb",
    });
  });

  it.each([
    ["Show.S01E01E02.1080p.WEB-DL-X", 1, [1, 2]],
    ["Show.S01E01-E03.1080p.WEB-DL-X", 1, [1, 2, 3]],
    ["Show.S02E10-12.720p.HDTV-X", 2, [10, 11, 12]],
    ["Show.1x05.720p.HDTV-X", 1, [5]],
    ["Show.2x01-03.720p.HDTV-X", 2, [1, 2, 3]],
  ])("reads the multi-episode range in %s", (title, season, episodes) => {
    expect(parseRelease(title).episodeRanges).toEqual([{ season, episodes }]);
  });

  it.each([
    ["Show.S03.1080p.WEB-DL.DDP5.1.H.264-GRP", [3]],
    ["Show.Season.3.1080p.WEB-DL-GRP", [3]],
    ["Show.S01-S03.COMPLETE.1080p.BluRay-GRP", [1, 2, 3]],
  ])("reads the season pack in %s", (title, seasons) => {
    const facts = parseRelease(title);
    expect(facts.kind).toBe("season");
    expect(facts.isSeasonPack).toBe(true);
    expect(facts.episodeRanges.map((r) => r.season)).toEqual(seasons);
    expect(facts.episodeRanges.every((r) => r.episodes.length === 0)).toBe(
      true,
    );
  });

  it("reads an anime absolute episode number", () => {
    const facts = parseRelease(
      "[SubsPlease] Some Show - 137 (1080p) [A1B2C3D4].mkv",
    );
    expect(facts.absoluteEpisodes).toEqual([137]);
    expect(facts.kind).toBe("episode");
    expect(facts.releaseGroup).toBe("SubsPlease");
    expect(facts.resolution).toBe("1080p");
  });

  it("does not read a year as a season", () => {
    const facts = parseRelease("Documentary.Series.2019.S01E04.1080p.WEB-DL-X");
    expect(facts.episodeRanges).toEqual([{ season: 1, episodes: [4] }]);
    expect(facts.year).toBe(2019);
  });
});

describe("what it refuses to invent", () => {
  it.each([
    ["", "unknown"],
    ["   ", "unknown"],
  ])("treats %p as unknown rather than as a movie", (title, kind) => {
    expect(parseRelease(title).kind).toBe(kind);
  });

  it("returns mostly-unknown facts for a title it cannot read, without throwing", () => {
    const facts = parseRelease("!!!!! ???? ####");
    expect(facts.resolution).toBe("unknown");
    expect(facts.source).toBe("unknown");
    expect(facts.videoCodec).toBe("unknown");
    expect(facts.releaseGroup).toBeUndefined();
    expect(facts.year).toBeUndefined();
  });

  it.each([
    "Movie.2020.1080p.BluRay.x264",
    "Movie.2020.1080p.BluRay.x264-",
    "Cloud.Atlas.2012.1080p.BluRay - 2012",
  ])("does not invent a group for %s", (title) => {
    expect(parseRelease(title).releaseGroup).toBeUndefined();
  });

  it("does not read a channel layout that is not one", () => {
    expect(
      parseRelease("Movie.2020.1080p.BluRay.x264-G").audioChannels,
    ).toBeUndefined();
  });

  it("survives titles with heavy punctuation and Unicode", () => {
    const facts = parseRelease(
      "Amélie.(Le.Fabuleux.Destin.d'Amélie.Poulain).2001.1080p.BluRay.FLAC.x264-GRP",
    );
    expect(facts.year).toBe(2001);
    expect(facts.videoCodec).toBe("avc");
    expect(facts.normalizedTitle).toContain("amélie");
  });

  it("reads a Turkish-language marker", () => {
    expect(
      parseRelease("Film.2021.1080p.WEB-DL.TURKISH.x264-GRP").languages,
    ).toContain("Turkish");
  });
});

describe("invariants that must hold for every title", () => {
  const corpus = [
    "Blade.Runner.2049.2017.2160p.AMZN.WEB-DL.DDP5.1.HDR.HEVC-MZABI",
    "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.TrueHD.7.1.Atmos-FraMeSToR",
    "The.Expanse.S05E03.1080p.AMZN.WEB-DL.DDP5.1.H.264-NTb",
    "Show.S01-S03.COMPLETE.1080p.BluRay.x264-GRP",
    "[SubsPlease] Some Show - 137 (1080p) [A1B2C3D4].mkv",
    "2012.2009.1080p.BluRay.x264-GROUP",
    "Movie.2020.REPACK2.2160p.WEB-DL.DV.HDR10+.Atmos-X",
    "Ambiguous 1080p 2160p Title 2019 WEB-DL",
    "!!!!! ???? ####",
    "",
    "Amélie.2001.1080p.BluRay.FLAC.x264-GRP",
    "Movie.Name.With.No.Year.1080p.WEB-DL-GRP",
    "Show.1x05.720p.HDTV.XviD-GRP",
    "Film.2021.1080p.WEB-DL.TURKISH.x264-GRP",
    "Movie.2020.1080p.BluRay.DTS-HD.MA.5.1.x264-GRP",
  ];

  it("never alters the title it was given", () => {
    for (const title of corpus) {
      expect(parseRelease(title).rawTitle).toBe(title);
    }
  });

  it("is deterministic", () => {
    for (const title of corpus) {
      expect(parseRelease(title)).toEqual(parseRelease(title));
    }
  });

  it("never throws, whatever it is handed", () => {
    const hostile = [
      ...corpus,
      "S99E99999",
      "S01E01-E9999",
      "a".repeat(5000),
      "1x1x1x1x1x1x1",
      " ",
      "....----....",
      "Season Season Season 1 2 3",
    ];
    for (const title of hostile) {
      expect(() => parseRelease(title)).not.toThrow();
    }
  });

  it("never produces an episode list longer than the span it read", () => {
    // A typo'd span must not materialise thousands of episode numbers.
    const facts = parseRelease("Show.S01E01-E9999.1080p-X");
    expect(facts.episodeRanges[0]!.episodes.length).toBeLessThanOrEqual(2);
  });

  it("only ever reports a season pack when it read a season", () => {
    for (const title of corpus) {
      const facts = parseRelease(title);
      if (facts.isSeasonPack)
        expect(facts.episodeRanges.length).toBeGreaterThan(0);
    }
  });

  it("reports unknown rather than a guess for every enumerated field", () => {
    const facts = parseRelease("Some Title Without Any Metadata");
    expect(facts.resolution).toBe("unknown");
    expect(facts.source).toBe("unknown");
    expect(facts.videoCodec).toBe("unknown");
    expect(facts.audioCodec).toBe("unknown");
    expect(facts.hdr).toEqual([]);
    expect(facts.edition).toEqual([]);
  });
});
