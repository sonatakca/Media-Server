/**
 * The replacement's command line, checked without spawning anything.
 *
 * The claim being tested is that a placeholder is not a different kind of
 * encode. Every setting that decides how the bitstream looks — encoder, preset,
 * level, pixel format, colour, GOP, segment length — comes from the same
 * builder the real epochs use, and only the input and the duration differ.
 * That is what makes the initialisation segments identical and the epochs
 * joinable; the integration test proves the consequence, this proves the cause.
 */

import { describe, expect, it } from "vitest";
import { buildAdaptivePackageFfmpegArgs } from "../encoding";
import {
  buildPlaceholderEpochArgs,
  formatFrameRateExpression,
  placeholderVideoSource,
} from "./placeholder";

const RUNGS = [
  { qualityHeight: 360, width: 640, height: 360 },
  { qualityHeight: 240, width: 426, height: 240 },
];

function placeholder(overrides: Record<string, unknown> = {}): string[] {
  return buildPlaceholderEpochArgs({
    directory: "/work/epoch.partial",
    videoOutputs: RUNGS,
    encoder: "libx264",
    frameRate: 24000 / 1001,
    segmentSeconds: 2,
    preset: "medium",
    durationSeconds: 299.966,
    ...overrides,
  } as never);
}

describe("formatFrameRateExpression", () => {
  it("writes NTSC rates as the rationals they actually are", () => {
    // 23.976 is not 24000/1001, and the difference decides the media timescale
    // the muxer picks — which decides whether the epoch can be joined at all.
    expect(formatFrameRateExpression(24000 / 1001)).toBe("24000/1001");
    expect(formatFrameRateExpression(23.976_02)).toBe("24000/1001");
    expect(formatFrameRateExpression(29.97)).toBe("30000/1001");
  });

  it("passes whole rates through unchanged", () => {
    expect(formatFrameRateExpression(25)).toBe("25");
    expect(formatFrameRateExpression(60)).toBe("60");
  });

  it("falls back to something usable rather than NaN", () => {
    expect(formatFrameRateExpression(undefined)).toBe("25");
    expect(formatFrameRateExpression(0)).toBe("25");
  });
});

describe("placeholderVideoSource", () => {
  it("is sized to the largest rung, so every rung scales down", () => {
    expect(placeholderVideoSource({ videoOutputs: RUNGS, frameRate: 25 })).toBe(
      "color=c=black:s=640x360:r=25",
    );
  });
});

describe("buildPlaceholderEpochArgs", () => {
  it("reads from a generator rather than from the unreadable source", () => {
    const args = placeholder();
    expect(args).toContain("lavfi");
    expect(args[args.indexOf("-i") + 1]).toBe(
      "color=c=black:s=640x360:r=24000/1001",
    );
  });

  it("never seeks, because there is nothing to seek in", () => {
    expect(placeholder()).not.toContain("-ss");
  });

  it("is given the planned length, not the length that was readable", () => {
    /*
     * The whole failure this exists for produced 123.290s of a 299.966s epoch.
     * Substituting the short figure would collapse the source timeline and pull
     * every later minute of the film earlier.
     */
    const args = placeholder();
    expect(args[args.indexOf("-t") + 1]).toBe("299.966000");
  });

  it("refuses to build a replacement with no length", () => {
    expect(() => placeholder({ durationSeconds: 0 })).toThrow(/length/i);
  });

  it("produces every rung in one process, as a real epoch does", () => {
    const args = placeholder();
    expect(args).toContain("[out0]");
    expect(args).toContain("[out1]");
    const map = args[args.indexOf("-var_stream_map") + 1];
    expect(map).toContain("video/360p");
    expect(map).toContain("video/240p");
  });

  it("differs from a real epoch's command only in its input and length", () => {
    /*
     * The strongest statement this file can make without running FFmpeg: take
     * the real epoch's arguments, swap the input for the generator and the
     * duration for the planned one, and what is left is identical — every
     * encoder flag, every filter, every HLS option.
     */
    const real = buildAdaptivePackageFfmpegArgs({
      inputPath: "/media/film.mkv",
      outputRoot: "/work/epoch.partial",
      videoOutputs: [...RUNGS],
      audioOutputs: [],
      encoder: "libx264",
      frameRate: 24000 / 1001,
      segmentSeconds: 2,
      preset: "medium",
      startSeconds: 3000.018,
      durationSeconds: 299.945,
    });
    const strip = (args: string[]): string[] => {
      const copy = [...args];
      // The input group, the seek and the output duration are the differences
      // under test; everything else must match exactly.
      for (const flag of ["-ss", "-t", "-i", "-f"]) {
        for (
          let index = copy.indexOf(flag);
          index >= 0;
          index = copy.indexOf(flag)
        ) {
          copy.splice(index, 2);
        }
      }
      // The trim filter exists only because a real epoch seeks; a generator
      // hands over no pre-roll frame to drop.
      return copy.map((value) =>
        value
          .replace("[0:v:0]trim=start=0,setpts=PTS-STARTPTS[epoch];", "")
          .replace("[epoch]", "[0:v:0]"),
      );
    };
    expect(strip(placeholder())).toEqual(strip(real));
  });
});
