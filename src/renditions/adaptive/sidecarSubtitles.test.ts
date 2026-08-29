import { describe, expect, it } from "vitest";
import {
  discoverSidecarSubtitles,
  parseSidecarSubtitleTags,
  SIDECAR_STREAM_INDEX_BASE,
} from "./sidecarSubtitles";

/**
 * Every filename here is one that actually appears in the library this was
 * written for, because the parsing only has to survive the shapes real
 * subtitles arrive in.
 */
describe("reading a sidecar subtitle's filename", () => {
  it("reads the language from the tag after the title", () => {
    expect(
      parseSidecarSubtitleTags(
        "Gladiator (2000) [98].tr.srt",
        "Gladiator (2000) [98]",
      ),
    ).toEqual({ language: "tur", isForced: false, isHearingImpaired: false });
  });

  it("reads a hearing-impaired tag alongside the language", () => {
    expect(
      parseSidecarSubtitleTags(
        "Dune (2021) [438631].tr.hi.srt",
        "Dune (2021) [438631]",
      ),
    ).toEqual({ language: "tur", isForced: false, isHearingImpaired: true });
  });

  it("accepts the three-letter language code too", () => {
    expect(
      parseSidecarSubtitleTags(
        "Star.Wars.Episode.IX.2019.2160p-[YTS.MX].tur.srt",
        "Star Wars - The Rise of Skywalker (2019) [181812]",
      ).language,
    ).toBe("tur");
  });

  /**
   * The title is not a description of the subtitle. A year in parentheses and a
   * bracketed provider id would both be read as tags if the stem were not
   * removed first.
   */
  it("does not read tags out of the title itself", () => {
    expect(
      parseSidecarSubtitleTags(
        "A Fistful of Dollars (1964) [391].tr.srt",
        "A Fistful of Dollars (1964) [391]",
      ),
    ).toEqual({ language: "tur", isForced: false, isHearingImpaired: false });
  });

  it("marks a forced track", () => {
    expect(
      parseSidecarSubtitleTags("Film.en.forced.srt", "Film").isForced,
    ).toBe(true);
  });

  it("reports no language rather than guessing one", () => {
    expect(parseSidecarSubtitleTags("Film.srt", "Film").language).toBe("und");
  });

  /** A disambiguating number is not a language. */
  it("ignores a numeric tag", () => {
    expect(
      parseSidecarSubtitleTags("Film [1895].en.2.srt", "Film [1895]"),
    ).toEqual({ language: "eng", isForced: false, isHearingImpaired: false });
  });
});

describe("finding the sidecars beside a source", () => {
  const listing = [
    "Dune (2021) [438631].mp4",
    "Dune (2021) [438631].tr.hi.srt",
    "Dune (2021) [438631].en.srt",
    "._Dune (2021) [438631].tr.hi.srt",
    "movie.nfo",
    "folder.jpg",
  ];

  it("keeps only subtitle files and skips AppleDouble companions", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Dune (2021)/Dune (2021) [438631].mp4",
      { readDirectory: (async () => listing) as never },
    );

    expect(found.map((entry) => entry.fileName)).toEqual([
      "Dune (2021) [438631].en.srt",
      "Dune (2021) [438631].tr.hi.srt",
    ]);
    expect(found.map((entry) => entry.language)).toEqual(["eng", "tur"]);
    expect(found[1]?.isHearingImpaired).toBe(true);
  });

  /**
   * A sidecar id has to be `subtitle-<index>` like any other, so the indexes
   * start above anything a container would plausibly contain.
   */
  it("gives each sidecar a synthetic index that cannot hit a real stream", async () => {
    const found = await discoverSidecarSubtitles(
      "/media/Dune (2021)/Dune (2021) [438631].mp4",
      { readDirectory: (async () => listing) as never },
    );

    expect(found.map((entry) => entry.streamIndex)).toEqual([
      SIDECAR_STREAM_INDEX_BASE,
      SIDECAR_STREAM_INDEX_BASE + 1,
    ]);
  });

  it("survives a directory it cannot read", async () => {
    await expect(
      discoverSidecarSubtitles("/media/Gone/Gone.mp4", {
        readDirectory: (async () => {
          throw new Error("ENOENT");
        }) as never,
      }),
    ).resolves.toEqual([]);
  });
});
