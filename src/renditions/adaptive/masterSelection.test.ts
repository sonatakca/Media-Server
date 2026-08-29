import { describe, expect, it } from "vitest";
import {
  applyAdaptiveMasterSelection,
  parseAdaptiveMasterSelection,
  selectVariantHeights,
} from "./masterSelection";

const MASTER = [
  "#EXTM3U",
  "#EXT-X-VERSION:7",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  "",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6",URI="audio/track-1/playlist.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Turkish",LANGUAGE="tur",DEFAULT=NO,AUTOSELECT=NO,CHANNELS="6",URI="audio/track-2/playlist.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="French",LANGUAGE="fra",DEFAULT=NO,AUTOSELECT=NO,CHANNELS="6",URI="audio/track-3/playlist.m3u8"',
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=1396942,RESOLUTION=854x356,CODECS="hvc1.2.4.L90.b0,mp4a.40.2",AUDIO="aud"',
  "video/480p/playlist.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=3516310,RESOLUTION=1280x534,CODECS="hvc1.2.4.L93.b0,mp4a.40.2",AUDIO="aud"',
  "video/720p/playlist.m3u8",
  "",
  '#EXT-X-STREAM-INF:BANDWIDTH=6627775,RESOLUTION=1920x802,CODECS="hvc1.2.4.L120.b0,mp4a.40.2",AUDIO="aud"',
  "video/1080p/playlist.m3u8",
  "",
].join("\n");

function variantUris(playlist: string): string[] {
  return playlist
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function audioRow(playlist: string, track: string): string {
  return playlist
    .split("\n")
    .find((line) => line.includes(`audio/${track}/playlist.m3u8`))!;
}

describe("applyAdaptiveMasterSelection", () => {
  it("returns the playlist untouched when nothing is selected", () => {
    expect(applyAdaptiveMasterSelection(MASTER, {})).toBe(MASTER);
  });

  it("locks to exactly the requested rung", () => {
    // A 2.39:1 1080p rung is 1920x802, so the request is matched against the
    // rung class in the URI rather than against the pixel height.
    const result = applyAdaptiveMasterSelection(MASTER, { height: 720 });

    expect(variantUris(result)).toEqual(["video/720p/playlist.m3u8"]);
  });

  it("keeps every rung at or below a ceiling", () => {
    const result = applyAdaptiveMasterSelection(MASTER, { maxHeight: 720 });

    expect(variantUris(result)).toEqual([
      "video/480p/playlist.m3u8",
      "video/720p/playlist.m3u8",
    ]);
  });

  it("resolves an exact height the ladder does not carry downwards", () => {
    const result = applyAdaptiveMasterSelection(MASTER, { height: 900 });

    expect(variantUris(result)).toEqual(["video/720p/playlist.m3u8"]);
  });

  it("never produces a master playlist with no variants", () => {
    const result = applyAdaptiveMasterSelection(MASTER, { height: 240 });

    expect(variantUris(result)).toEqual(["video/480p/playlist.m3u8"]);
  });

  it("keeps the audio renditions when only the video is filtered", () => {
    const result = applyAdaptiveMasterSelection(MASTER, { height: 480 });

    expect(result).toContain("audio/track-1/playlist.m3u8");
    expect(result).toContain("audio/track-2/playlist.m3u8");
    expect(result).toContain("audio/track-3/playlist.m3u8");
  });

  it("makes the requested audio rendition the default one", () => {
    // This is the only control surface Safari's native HLS engine honours: it
    // picks the DEFAULT/AUTOSELECT rendition and exposes no audio track API.
    const result = applyAdaptiveMasterSelection(MASTER, {
      audioStreamIndex: 2,
    });

    expect(audioRow(result, "track-2")).toContain("DEFAULT=YES");
    expect(audioRow(result, "track-2")).toContain("AUTOSELECT=YES");
    expect(audioRow(result, "track-1")).toContain("DEFAULT=NO");
    expect(audioRow(result, "track-1")).toContain("AUTOSELECT=NO");
    expect(audioRow(result, "track-3")).toContain("DEFAULT=NO");
  });

  it("selects the third audio rendition as readily as the second", () => {
    const result = applyAdaptiveMasterSelection(MASTER, {
      audioStreamIndex: 3,
    });

    expect(audioRow(result, "track-3")).toContain("DEFAULT=YES");
    expect(audioRow(result, "track-1")).toContain("DEFAULT=NO");
    expect(audioRow(result, "track-2")).toContain("DEFAULT=NO");
  });

  it("leaves the package default in place for an unknown audio rendition", () => {
    const result = applyAdaptiveMasterSelection(MASTER, {
      audioStreamIndex: 9,
    });

    expect(audioRow(result, "track-1")).toContain("DEFAULT=YES");
  });

  it("applies an audio and a quality selection together", () => {
    const result = applyAdaptiveMasterSelection(MASTER, {
      height: 1080,
      audioStreamIndex: 2,
    });

    expect(variantUris(result)).toEqual(["video/1080p/playlist.m3u8"]);
    expect(audioRow(result, "track-2")).toContain("DEFAULT=YES");
  });

  it("selects human-named title-layout renditions", () => {
    const titleMaster = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,AUTOSELECT=YES,X-SEYIRLIK-STREAM-INDEX=1,URI="audio/english%20(original).m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Turkish",DEFAULT=NO,AUTOSELECT=NO,X-SEYIRLIK-STREAM-INDEX=2,URI="audio/turkish.m3u8"',
      "#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x534",
      "video/720p60%20HDR.m3u8",
      "#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1920x802",
      "video/1080p60%20HDR.m3u8",
    ].join("\n");

    const result = applyAdaptiveMasterSelection(titleMaster, {
      height: 1080,
      audioStreamIndex: 2,
    });

    expect(variantUris(result)).toEqual(["video/1080p60%20HDR.m3u8"]);
    expect(
      result
        .split("\n")
        .find((line) => line.includes('URI="audio/turkish.m3u8"')),
    ).toContain("DEFAULT=YES");
  });

  it("keeps the media playlist references relative", () => {
    // They resolve against the master's own URL, so the query string that
    // carried the selection must not leak into them.
    const result = applyAdaptiveMasterSelection(MASTER, { height: 480 });

    for (const uri of variantUris(result)) {
      expect(uri.startsWith("http")).toBe(false);
      expect(uri).not.toContain("?");
    }
  });
});

describe("selectVariantHeights", () => {
  it("returns every rung when nothing is requested", () => {
    expect(selectVariantHeights([480, 720, 1080], {})).toEqual([
      1080, 720, 480,
    ]);
  });

  it("prefers an exact lock over a ceiling", () => {
    expect(
      selectVariantHeights([480, 720, 1080], { height: 720, maxHeight: 1080 }),
    ).toEqual([720]);
  });

  it("returns nothing for an empty ladder", () => {
    expect(selectVariantHeights([], { height: 720 })).toEqual([]);
  });
});

describe("parseAdaptiveMasterSelection", () => {
  it("reads every supported parameter", () => {
    expect(
      parseAdaptiveMasterSelection(
        new URLSearchParams("height=720&maxHeight=1080&audioStreamIndex=2"),
      ),
    ).toEqual({ height: 720, maxHeight: 1080, audioStreamIndex: 2 });
  });

  it("ignores values that are not usable rendition selectors", () => {
    expect(
      parseAdaptiveMasterSelection(
        new URLSearchParams("height=abc&maxHeight=-5&audioStreamIndex=1.5"),
      ),
    ).toEqual({});
  });

  it("returns an empty selection for a bare URL", () => {
    expect(parseAdaptiveMasterSelection(new URLSearchParams(""))).toEqual({});
  });
});
