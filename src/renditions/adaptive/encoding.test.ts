import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_AUDIO_GROUP,
  adaptiveOutputDirectories,
  buildAdaptiveFilterComplex,
  buildAdaptivePackageFfmpegArgs,
  buildVarStreamMap,
  canStreamCopyAudio,
  type AdaptiveAudioOutput,
  type AdaptiveVideoOutput,
} from "./encoding";

const LADDER: AdaptiveVideoOutput[] = [
  { qualityHeight: 480, width: 854, height: 480 },
  { qualityHeight: 720, width: 1280, height: 720 },
  { qualityHeight: 1080, width: 1920, height: 1080 },
];

const DEFAULT_AUDIO: AdaptiveAudioOutput = {
  sourceStreamIndex: 1,
  action: "transcode",
  bitrate: 192_000,
  language: "eng",
  isDefault: true,
  isForced: false,
};

function build(
  overrides: Partial<Parameters<typeof buildAdaptivePackageFfmpegArgs>[0]> = {},
) {
  return buildAdaptivePackageFfmpegArgs({
    inputPath: "/media/Movies/Example.mp4",
    outputRoot: "/work/example",
    videoOutputs: LADDER,
    audioOutputs: [DEFAULT_AUDIO],
    frameRate: 23.976,
    ...overrides,
  });
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("buildAdaptiveFilterComplex", () => {
  it("decodes once and splits into every rendition", () => {
    const graph = buildAdaptiveFilterComplex({ videoOutputs: LADDER });

    expect(graph).toContain("[0:v:0]split=3[split0][split1][split2]");
    expect(graph).toContain(
      "[split0]scale=854:480:flags=lanczos,format=yuv420p[out0]",
    );
    expect(graph).toContain(
      "[split2]scale=1920:1080:flags=lanczos,format=yuv420p[out2]",
    );
  });

  it("skips the split when there is only one rendition", () => {
    const graph = buildAdaptiveFilterComplex({ videoOutputs: [LADDER[0]] });

    expect(graph).not.toContain("split=");
    expect(graph).toContain("[0:v:0]scale=854:480");
  });

  it("uses a 10-bit pixel format when the HDR grade is being carried through", () => {
    const graph = buildAdaptiveFilterComplex({
      videoOutputs: [LADDER[0]],
      encoder: "libx265",
      hdr: {
        colorPrimaries: "bt2020",
        colorTransfer: "smpte2084",
        colorSpace: "bt2020nc",
      },
    });

    expect(graph).toContain("format=yuv420p10le");
  });

  it("rejects an empty ladder", () => {
    expect(() => buildAdaptiveFilterComplex({ videoOutputs: [] })).toThrow(
      /at least one adaptive video rendition/i,
    );
  });
});

describe("buildVarStreamMap", () => {
  it("names entries so they land in the canonical package layout", () => {
    const map = buildVarStreamMap({
      videoOutputs: LADDER,
      audioOutputs: [
        DEFAULT_AUDIO,
        {
          ...DEFAULT_AUDIO,
          sourceStreamIndex: 2,
          isDefault: false,
          language: "tur",
        },
      ],
    });

    expect(map).toContain(`v:0,agroup:${ADAPTIVE_AUDIO_GROUP},name:video/480p`);
    expect(map).toContain(
      `v:2,agroup:${ADAPTIVE_AUDIO_GROUP},name:video/1080p`,
    );
    expect(map).toContain(
      "a:0,agroup:aud,name:audio/track-1,default:yes,language:eng",
    );
    expect(map).toContain("a:1,agroup:aud,name:audio/track-2,language:tur");
  });
});

describe("adaptiveOutputDirectories", () => {
  it("lists every directory the muxer expects to already exist", () => {
    expect(
      adaptiveOutputDirectories({
        videoOutputs: LADDER,
        audioOutputs: [DEFAULT_AUDIO],
      }),
    ).toEqual(["video/480p", "video/720p", "video/1080p", "audio/track-1"]);
  });
});

describe("buildAdaptivePackageFfmpegArgs", () => {
  it("forces a two-second closed GOP on every rendition, not just the first", () => {
    const args = build();

    // A `-force_key_frames` without a stream specifier only reaches the first
    // video output, which would leave the rest of the ladder unaligned.
    for (const ordinal of [0, 1, 2]) {
      expect(args).toContain(`-force_key_frames:v:${ordinal}`);
      expect(valueAfter(args, `-force_key_frames:v:${ordinal}`)).toBe(
        "expr:gte(t,n_forced*2)",
      );
      expect(valueAfter(args, `-g:v:${ordinal}`)).toBe("48");
      expect(valueAfter(args, `-flags:v:${ordinal}`)).toBe("+cgop");
      expect(valueAfter(args, `-sc_threshold:v:${ordinal}`)).toBe("0");
      expect(valueAfter(args, `-keyint_min:v:${ordinal}`)).toBe("48");
      expect(valueAfter(args, `-forced-idr:v:${ordinal}`)).toBe("1");
    }
  });

  it.each([
    [23.976, "48"],
    [24, "48"],
    [25, "50"],
    [59.94, "120"],
  ])(
    "derives the GOP length from %s fps as %s frames",
    (frameRate, expected) => {
      const args = build({ frameRate });
      expect(valueAfter(args, "-g:v:0")).toBe(expected);
    },
  );

  it("produces video-only variants", () => {
    const args = build();

    expect(args).toContain("-sn");
    expect(args).toContain("-dn");
    // Audio is mapped once for the whole package, never per video variant.
    expect(args.filter((argument) => argument === "-map").length).toBe(4);
    expect(args.filter((argument) => argument.startsWith("0:1")).length).toBe(
      1,
    );
  });

  it("shares one audio rendition across every video variant", () => {
    const args = build();

    expect(valueAfter(args, "-var_stream_map")).toBe(
      "v:0,agroup:aud,name:video/480p v:1,agroup:aud,name:video/720p v:2,agroup:aud,name:video/1080p a:0,agroup:aud,name:audio/track-1,default:yes,language:eng",
    );
    expect(valueAfter(args, "-c:a:0")).toBe("aac");
    expect(valueAfter(args, "-b:a:0")).toBe("192000");
    expect(valueAfter(args, "-ar:a:0")).toBe("48000");
  });

  it("stream-copies audio when the source is already browser-compatible", () => {
    const args = build({
      audioOutputs: [{ ...DEFAULT_AUDIO, action: "copy" }],
    });

    expect(valueAfter(args, "-c:a:0")).toBe("copy");
    expect(args).not.toContain("-b:a:0");
  });

  it("carries language, title and disposition through to each audio rendition", () => {
    const args = build({
      audioOutputs: [
        { ...DEFAULT_AUDIO, title: "Director commentary" },
        {
          sourceStreamIndex: 2,
          action: "transcode",
          bitrate: 256_000,
          language: "tur",
          isDefault: false,
          isForced: true,
        },
      ],
    });

    expect(args).toContain("language=eng");
    expect(args).toContain("title=Director commentary");
    expect(args).toContain("language=tur");
    expect(valueAfter(args, "-disposition:a:0")).toBe("default");
    expect(valueAfter(args, "-disposition:a:1")).toBe("forced");
  });

  it("writes single-file byte-range CMAF with independent segments", () => {
    const args = build();

    expect(valueAfter(args, "-hls_segment_type")).toBe("fmp4");
    expect(valueAfter(args, "-hls_flags")).toBe(
      "single_file+independent_segments",
    );
    expect(valueAfter(args, "-hls_time")).toBe("2");
    expect(valueAfter(args, "-hls_playlist_type")).toBe("vod");
    expect(valueAfter(args, "-hls_segment_filename")).toBe(
      "/work/example/%v/media.m4s",
    );
    expect(args.at(-1)).toBe("/work/example/%v/playlist.m3u8");
  });

  it("tags HEVC output as hvc1 and writes the HDR colour signal per rendition", () => {
    const args = build({
      encoder: "libx265",
      videoOutputs: [LADDER[0], LADDER[1]],
      hdr: {
        colorPrimaries: "bt2020",
        colorTransfer: "smpte2084",
        colorSpace: "bt2020nc",
      },
    });

    for (const ordinal of [0, 1]) {
      // Safari refuses hev1-tagged media outright.
      expect(valueAfter(args, `-tag:v:${ordinal}`)).toBe("hvc1");
      expect(valueAfter(args, `-color_trc:v:${ordinal}`)).toBe("smpte2084");
      expect(valueAfter(args, `-color_primaries:v:${ordinal}`)).toBe("bt2020");
      expect(valueAfter(args, `-colorspace:v:${ordinal}`)).toBe("bt2020nc");
      expect(valueAfter(args, `-x265-params:v:${ordinal}`)).toContain(
        "scenecut=0",
      );
    }
  });

  it("does not tag H.264 output as hvc1", () => {
    expect(build()).not.toContain("-tag:v:0");
  });

  it("refuses to preserve HDR on an H.264 encoder", () => {
    expect(() =>
      build({
        encoder: "libx264",
        hdr: {
          colorPrimaries: "bt2020",
          colorTransfer: "smpte2084",
          colorSpace: "bt2020nc",
        },
      }),
    ).toThrow(/no browser decodes 10-bit H.264/i);
  });

  it("requires exactly one default audio rendition", () => {
    expect(() => build({ audioOutputs: [] })).toThrow(
      /at least one audio rendition/i,
    );
    expect(() =>
      build({
        audioOutputs: [
          DEFAULT_AUDIO,
          { ...DEFAULT_AUDIO, sourceStreamIndex: 2 },
        ],
      }),
    ).toThrow(/exactly one adaptive audio rendition must be default/i);
  });
});

describe("canStreamCopyAudio", () => {
  it("copies plain stereo AAC-LC", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "LC",
        sampleRate: 48_000,
        channels: 2,
      }),
    ).toBe(true);
  });

  it("re-encodes anything that is not AAC", () => {
    for (const codec of ["ac3", "eac3", "dts", "truehd", "opus"]) {
      expect(canStreamCopyAudio({ codec, channels: 2 })).toBe(false);
    }
  });

  it("re-encodes HE-AAC, whose implicit signalling survives a remux badly", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "HE-AAC",
        sampleRate: 48_000,
        channels: 2,
      }),
    ).toBe(false);
  });

  it("re-encodes multichannel AAC rather than narrowing who can play the ladder", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "LC",
        sampleRate: 48_000,
        channels: 6,
      }),
    ).toBe(false);
  });

  it("re-encodes unusual sample rates", () => {
    expect(
      canStreamCopyAudio({
        codec: "aac",
        profile: "LC",
        sampleRate: 22_050,
        channels: 2,
      }),
    ).toBe(false);
  });
});
