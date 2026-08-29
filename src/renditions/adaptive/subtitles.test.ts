import { describe, expect, it } from "vitest";
import {
  buildWebVttExtractionArgs,
  buildWebVttMediaPlaylist,
  parseWebVttMediaPlaylist,
} from "./subtitles";

describe("adaptive WebVTT packaging", () => {
  it("maps exactly the selected source stream", () => {
    expect(
      buildWebVttExtractionArgs("/source/movie.mkv", 7, "/stage/sub.vtt"),
    ).toEqual([
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      "/source/movie.mkv",
      "-map",
      "0:7",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "/stage/sub.vtt",
    ]);
  });

  it("builds a complete VOD playlist for arbitrary cue timing", () => {
    const playlist = buildWebVttMediaPlaylist(32.423, "subtitles.vtt");
    expect(parseWebVttMediaPlaylist(playlist)).toEqual({
      durationSeconds: 32.423,
      uri: "subtitles.vtt",
    });
    expect(playlist).toContain("#EXT-X-ENDLIST");
  });

  it("rejects an incomplete subtitle playlist", () => {
    expect(() => parseWebVttMediaPlaylist("#EXTM3U\n")).toThrow(/complete/);
  });
});
