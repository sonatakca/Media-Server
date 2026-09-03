/**
 * The soundtrack built around a hole, as a command rather than as bytes.
 *
 * Two properties carry the whole design and both are checked here. The pieces
 * are joined inside one filter graph, so each track is a single continuous
 * encode with no seam and no accumulated encoder priming. And the silence is
 * exactly as long as the interval it stands for, so everything after the hole
 * keeps its own place on the timeline instead of being pulled earlier.
 */

import { describe, expect, it } from "vitest";
import {
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveAudioOutput,
} from "../encoding";
import {
  channelLayoutFor,
  planSalvagedAudio,
  SALVAGE_AUDIO_SAMPLE_RATE,
  sameDamagedIntervals,
  silenceInput,
} from "./audioSalvage";

const TRACKS: AdaptiveAudioOutput[] = [
  {
    sourceStreamIndex: 1,
    action: "copy",
    bitrate: 192_000,
    channels: 6,
    language: "eng",
    isDefault: true,
    isForced: false,
  },
  {
    sourceStreamIndex: 2,
    action: "transcode",
    bitrate: 192_000,
    channels: 2,
    language: "tur",
    isDefault: false,
    isForced: false,
  },
];

function plan() {
  return planSalvagedAudio({
    sourcePath: "/media/film.mkv",
    audioOutputs: TRACKS,
    damagedIntervals: [{ startSeconds: 3000.039, endSeconds: 3300.005 }],
    sourceDurationSeconds: 9039.2,
  });
}

describe("planSalvagedAudio", () => {
  it("reads the source only in the stretches that can be read", () => {
    const { inputs } = plan();
    const fromSource = inputs.filter(
      (input) => input.path === "/media/film.mkv",
    );
    expect(fromSource).toHaveLength(2);
    expect(fromSource[0]!.startSeconds).toBeUndefined();
    expect(fromSource[0]!.durationSeconds).toBeCloseTo(3000.039, 3);
    expect(fromSource[1]!.startSeconds).toBeCloseTo(3300.005, 3);
    expect(fromSource[1]!.durationSeconds).toBeCloseTo(9039.2 - 3300.005, 3);
  });

  it("opens each readable stretch once for every track, not once per track", () => {
    // Two tracks, two readable stretches: two reads, not four. The source's
    // audio streams all arrive through the same input.
    const { inputs } = plan();
    expect(
      inputs.filter((input) => input.path === "/media/film.mkv"),
    ).toHaveLength(2);
  });

  it("generates silence of exactly the damaged length, per track", () => {
    const { inputs } = plan();
    const generators = inputs.filter((input) => input.format === "lavfi");
    // A filter pad may be consumed once, so each track needs its own.
    expect(generators).toHaveLength(TRACKS.length);
    for (const generator of generators) {
      expect(generator.durationSeconds).toBeCloseTo(299.966, 6);
    }
  });

  it("joins the pieces in the filter graph, so a track is one encode", () => {
    const { filterComplex } = plan();
    expect(filterComplex).toContain("concat=n=3:v=0:a=1[aout0]");
    expect(filterComplex).toContain("concat=n=3:v=0:a=1[aout1]");
    // Nothing is concatenated as files, which is what would add each part's
    // encoder priming to the timeline.
    expect(filterComplex).not.toContain("concat:");
  });

  it("brings every piece to one rate and layout before joining", () => {
    const { filterComplex } = plan();
    expect(filterComplex).toContain(`aresample=${SALVAGE_AUDIO_SAMPLE_RATE}`);
    expect(filterComplex).toContain("aformat=sample_fmts=fltp");
  });

  it("encodes rather than copies, so the halves cannot disagree", () => {
    const { outputs } = plan();
    expect(outputs.every((output) => output.action === "transcode")).toBe(true);
    // The stream copy the healthy path would have used is deliberately dropped.
    expect(TRACKS[0]!.action).toBe("copy");
  });

  it("keeps every selected track, not only the default one", () => {
    const { outputs } = plan();
    expect(outputs.map((output) => output.sourceStreamIndex)).toEqual([1, 2]);
    expect(outputs.map((output) => output.mapLabel)).toEqual([
      "[aout0]",
      "[aout1]",
    ]);
  });

  it("keeps the delivery channel cap a healthy encode would apply", () => {
    expect(plan().outputs[0]!.channels).toBe(2);
    expect(channelLayoutFor(1)).toBe("mono");
    expect(channelLayoutFor(2)).toBe("stereo");
  });

  it("refuses a plan with no tracks or no timeline", () => {
    expect(() =>
      planSalvagedAudio({
        sourcePath: "/media/film.mkv",
        audioOutputs: [],
        damagedIntervals: [],
        sourceDurationSeconds: 100,
      }),
    ).toThrow(/track/i);
    expect(() =>
      planSalvagedAudio({
        sourcePath: "/media/film.mkv",
        audioOutputs: TRACKS,
        damagedIntervals: [],
        sourceDurationSeconds: 0,
      }),
    ).toThrow(/duration/i);
  });
});

describe("the command the plan produces", () => {
  it("names every input and maps every track from the graph", () => {
    const { inputs, filterComplex, outputs } = plan();
    const args = buildAdaptivePackageFfmpegArgs({
      inputPath: "/media/film.mkv",
      inputs,
      audioFilterComplex: filterComplex,
      outputRoot: "/work/audio-stage",
      videoOutputs: [],
      audioOutputs: outputs,
    });
    expect(args.filter((value) => value === "-i")).toHaveLength(inputs.length);
    expect(args).toContain("[aout0]");
    expect(args).toContain("[aout1]");
    expect(args[args.indexOf("-filter_complex") + 1]).toBe(filterComplex);
  });

  it("still writes each rendition under its source-stream identity", () => {
    const { inputs, filterComplex, outputs } = plan();
    const args = buildAdaptivePackageFfmpegArgs({
      inputPath: "/media/film.mkv",
      inputs,
      audioFilterComplex: filterComplex,
      outputRoot: "/work/audio-stage",
      videoOutputs: [],
      audioOutputs: outputs,
    });
    const map = args[args.indexOf("-var_stream_map") + 1]!;
    expect(map).toContain("audio/track-1");
    expect(map).toContain("audio/track-2");
  });
});

describe("silenceInput", () => {
  it("asks for the layout and rate the track will be delivered at", () => {
    expect(
      silenceInput(
        {
          startSeconds: 10,
          endSeconds: 20,
          durationSeconds: 10,
          kind: "synthetic",
        },
        2,
      ),
    ).toEqual({
      path: "anullsrc=channel_layout=stereo:sample_rate=48000",
      format: "lavfi",
      durationSeconds: 10,
    });
  });
});

describe("sameDamagedIntervals", () => {
  it("keeps a healthy stage from being reused once a hole is found", () => {
    expect(
      sameDamagedIntervals(undefined, [{ startSeconds: 1, endSeconds: 2 }]),
    ).toBe(false);
    expect(sameDamagedIntervals([], undefined)).toBe(true);
  });

  it("keeps a salvaged stage from being reused for a different hole", () => {
    expect(
      sameDamagedIntervals(
        [{ startSeconds: 3000, endSeconds: 3300 }],
        [{ startSeconds: 3300, endSeconds: 3600 }],
      ),
    ).toBe(false);
    expect(
      sameDamagedIntervals(
        [{ startSeconds: 3000, endSeconds: 3300 }],
        [{ startSeconds: 3000.0001, endSeconds: 3300 }],
      ),
    ).toBe(true);
  });
});
