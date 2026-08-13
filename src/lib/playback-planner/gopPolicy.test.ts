import { describe, expect, it } from "vitest";
import {
  buildForcedKeyframeArgs,
  buildGopArgs,
  computeGopFrames,
  DEFAULT_VIDEO_FRAMERATE,
  SEGMENT_TARGET_SECONDS,
  sourceFrameDurationSeconds,
} from "./gopPolicy";

function argumentValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("computeGopFrames", () => {
  it.each([
    [23.976, 48],
    [24, 48],
    [25, 50],
    [29.97, 60],
    [30, 60],
    [50, 100],
    [59.94, 120],
    [60, 120],
  ])(
    "derives %s fps as %i frames per two-second GOP",
    (frameRate, expected) => {
      expect(computeGopFrames(frameRate)).toBe(expected);
    },
  );

  it("rounds rather than truncates so 23.976 fps does not drift short", () => {
    // 23.976 * 2 = 47.952. Truncating would place keyframes 1.96s apart, which
    // creeps forward against the time-based forced-keyframe expression until
    // the two disagree by a whole frame.
    expect(computeGopFrames(23.976)).toBe(48);
    expect(computeGopFrames(23.976)).toBeGreaterThan(Math.floor(23.976 * 2));
  });

  it("falls back to the default rate when the probe reports nothing usable", () => {
    for (const value of [
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      5000,
    ]) {
      expect(computeGopFrames(value as number | undefined)).toBe(
        DEFAULT_VIDEO_FRAMERATE * SEGMENT_TARGET_SECONDS,
      );
    }
  });

  it("honours a non-default segment length", () => {
    expect(computeGopFrames(25, 4)).toBe(100);
  });
});

describe("sourceFrameDurationSeconds", () => {
  it("is the alignment tolerance a ladder is judged against", () => {
    expect(sourceFrameDurationSeconds(25)).toBeCloseTo(0.04, 6);
    expect(sourceFrameDurationSeconds(23.976)).toBeCloseTo(0.041708, 5);
  });

  it("falls back to the default rate for unusable input", () => {
    expect(sourceFrameDurationSeconds(undefined)).toBeCloseTo(1 / 30, 6);
  });
});

describe("buildForcedKeyframeArgs", () => {
  it("places keyframes on presentation time, not on frame counts", () => {
    expect(buildForcedKeyframeArgs()).toEqual([
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
    ]);
  });
});

describe("buildGopArgs", () => {
  it("gives libx264 a fixed, closed, scene-cut-free GOP with forced IDRs", () => {
    const args = buildGopArgs({ encoder: "libx264", frameRate: 23.976 });

    expect(argumentValue(args, "-g")).toBe("48");
    expect(argumentValue(args, "-keyint_min")).toBe("48");
    expect(argumentValue(args, "-sc_threshold")).toBe("0");
    expect(argumentValue(args, "-flags")).toBe("+cgop");
    expect(argumentValue(args, "-force_key_frames")).toBe(
      "expr:gte(t,n_forced*2)",
    );
    // Without this a forced keyframe can be a non-IDR I-frame, which a decoder
    // cannot start on — so a segment beginning there is not independently
    // decodable at all.
    expect(argumentValue(args, "-forced-idr")).toBe("1");
  });

  it("reaches libx265 through its own parameter string", () => {
    const args = buildGopArgs({ encoder: "libx265", frameRate: 25 });

    // libx265 ignores `-keyint_min` and `-sc_threshold` with a warning, so
    // restating the x264 flags here would silently leave HDR renditions on the
    // encoder's own cadence.
    expect(args).not.toContain("-keyint_min");
    expect(args).not.toContain("-sc_threshold");
    expect(argumentValue(args, "-x265-params")).toBe(
      "keyint=50:min-keyint=50:scenecut=0:open-gop=0",
    );
    expect(argumentValue(args, "-g")).toBe("50");
    expect(argumentValue(args, "-forced-idr")).toBe("1");
  });

  it("asks QuickSync for forced IDRs rather than a scene-cut threshold it has no concept of", () => {
    for (const encoder of ["h264_qsv", "hevc_qsv"] as const) {
      const args = buildGopArgs({ encoder, frameRate: 59.94 });
      expect(argumentValue(args, "-g")).toBe("120");
      expect(argumentValue(args, "-forced_idr")).toBe("1");
      expect(args).not.toContain("-sc_threshold");
      expect(args).not.toContain("-keyint_min");
    }
  });

  it("passes VideoToolbox nothing it would reject", () => {
    const args = buildGopArgs({ encoder: "h264_videotoolbox", frameRate: 30 });

    // VideoToolbox exposes neither option, and FFmpeg rejects the whole command
    // when handed one an encoder does not define.
    expect(args).not.toContain("-forced-idr");
    expect(args).not.toContain("-sc_threshold");
    expect(argumentValue(args, "-g")).toBe("60");
    expect(argumentValue(args, "-force_key_frames")).toBe(
      "expr:gte(t,n_forced*2)",
    );
  });

  it("always closes the GOP whatever the encoder", () => {
    for (const encoder of [
      "libx264",
      "libx265",
      "h264_qsv",
      "hevc_qsv",
      "h264_nvenc",
      "h264_amf",
      "h264_videotoolbox",
    ] as const) {
      expect(buildGopArgs({ encoder, frameRate: 25 })).toContain("+cgop");
    }
  });
});
