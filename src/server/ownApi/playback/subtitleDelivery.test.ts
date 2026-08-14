import { describe, expect, it } from "vitest";
import { buildSubtitleExtractionArgs } from "./subtitleDelivery";

describe("subtitle delivery", () => {
  it("maps exactly one input stream to WebVTT on stdout", () => {
    expect(buildSubtitleExtractionArgs("/media/Movie.mkv", 10_000)).toEqual([
      "-v",
      "error",
      "-nostdin",
      "-i",
      "/media/Movie.mkv",
      "-map",
      "0:10000",
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "pipe:1",
    ]);
  });
});
