import { describe, expect, it } from "vitest";
import { parseRenditionProbe } from "./probe";

describe("rendition ffprobe parsing", () => {
  it("records dimensions, rotation, frame rate, bit depth, tracks and chapters", () => {
    const result = parseRenditionProbe({
      format: { duration: "123.5", bit_rate: "12000000" },
      streams: [
        {
          index: 0,
          codec_type: "video",
          codec_name: "hevc",
          width: 3840,
          height: 2160,
          avg_frame_rate: "24000/1001",
          pix_fmt: "yuv420p10le",
          side_data_list: [{ rotation: 90 }],
        },
        {
          index: 1,
          codec_type: "audio",
          codec_name: "truehd",
          channels: 8,
          tags: { language: "eng", title: "Atmos" },
          disposition: { default: 1 },
        },
        {
          index: 2,
          codec_type: "subtitle",
          codec_name: "subrip",
          tags: { language: "tur" },
          disposition: { forced: 1 },
        },
      ],
      chapters: [
        { id: 0, start_time: "0", end_time: "12.25", tags: { title: "Intro" } },
      ],
    });

    expect(result.durationSeconds).toBe(123.5);
    expect(result.overallBitrate).toBe(12_000_000);
    expect(result.video).toMatchObject({
      streamIndex: 0,
      codec: "hevc",
      width: 3840,
      height: 2160,
      rotation: 90,
      bitDepth: 10,
      pixelFormat: "yuv420p10le",
    });
    expect(result.video?.frameRate).toBeCloseTo(23.976, 3);
    expect(result.audioTracks).toEqual([
      {
        streamIndex: 1,
        codec: "truehd",
        channels: 8,
        language: "eng",
        title: "Atmos",
        isDefault: true,
      },
    ]);
    expect(result.subtitleTracks).toEqual([
      {
        streamIndex: 2,
        codec: "subrip",
        language: "tur",
        title: undefined,
        isDefault: false,
        isForced: true,
      },
    ]);
    expect(result.chapters).toEqual([
      { id: 0, startSeconds: 0, endSeconds: 12.25, title: "Intro" },
    ]);
  });

  it("rejects probe output without a usable video stream", () => {
    expect(() => parseRenditionProbe({ streams: [] })).toThrow(
      "usable video stream",
    );
  });
});
