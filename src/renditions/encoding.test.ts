import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRenditionFfmpegArgs,
  buildRenditionFilterComplex,
  parseEncoderPreference,
} from "./encoding";

const workRoot = path.join("D:\\media", ".seyirlik", "work", "id");

function outputs() {
  return [
    {
      qualityHeight: 1080,
      width: 1920,
      height: 802,
      outputPath: path.join(workRoot, "1080p.partial.mp4"),
    },
    {
      qualityHeight: 480,
      width: 854,
      height: 356,
      outputPath: path.join(workRoot, "480p.partial.mp4"),
    },
  ];
}

describe("standalone rendition encoding commands", () => {
  it("builds a shell-free FFmpeg argument array for complete fast-start MP4s", () => {
    const args = buildRenditionFfmpegArgs({
      inputPath: "D:\\media\\Movies\\Çağrı & Film.mkv",
      outputs: outputs(),
      audioStreamIndex: 2,
      audioLanguage: "tur",
    });

    expect(args).toContain("D:\\media\\Movies\\Çağrı & Film.mkv");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args).toContain("0:2");
    expect(args).toContain("language=tur");
    expect(args[args.length - 1]).toBe(path.join(workRoot, "480p.partial.mp4"));
    expect(args).not.toContain("hls");
    expect(
      args.some((argument) => /\.m3u8$|\.m4s$|\.ts$/i.test(argument)),
    ).toBe(false);
    expect(args).not.toContain("sh");
    expect(args).not.toContain("cmd.exe");
  });

  it("decodes once and splits into every requested rendition", () => {
    const filter = buildRenditionFilterComplex({ outputs: outputs() });

    expect(filter).toBe(
      "[0:v:0]split=2[split0][split1];" +
        "[split0]scale=1920:802:flags=lanczos,format=yuv420p[out0];" +
        "[split1]scale=854:356:flags=lanczos,format=yuv420p[out1]",
    );
    // A single rendition needs no split stage.
    expect(buildRenditionFilterComplex({ outputs: [outputs()[0]] })).toBe(
      "[0:v:0]scale=1920:802:flags=lanczos,format=yuv420p[out0]",
    );
  });

  it("tone maps HDR sources once before the split", () => {
    const filter = buildRenditionFilterComplex({
      outputs: outputs(),
      tonemapHdr: true,
    });

    expect(filter).toContain("zscale=t=linear:npl=100");
    expect(filter).toContain("tonemap=tonemap=hable:desat=0");
    expect(filter).toContain("[tonemapped]split=2");
    // Tone mapping must run exactly once, not per rendition.
    expect(filter.match(/tonemap=tonemap/g)).toHaveLength(1);
  });

  it("emits QuickSync rate control and nv12 frames when QSV is selected", () => {
    const args = buildRenditionFfmpegArgs({
      inputPath: "D:\\media\\Movies\\Film.mkv",
      outputs: outputs(),
      audioStreamIndex: 1,
      encoder: "h264_qsv",
    });

    expect(args).toContain("h264_qsv");
    expect(args).not.toContain("libx264");
    expect(args).toContain("-global_quality");
    expect(args).not.toContain("-crf");
    expect(args.join(" ")).toContain("format=nv12");
  });

  it("validates the configured encoder preference", () => {
    expect(parseEncoderPreference(undefined)).toBe("auto");
    expect(parseEncoderPreference(" QSV ")).toBe("qsv");
    expect(parseEncoderPreference("software")).toBe("software");
    expect(() => parseEncoderPreference("nvenc")).toThrow(
      /must be `auto`, `qsv` or `software`/,
    );
  });
});
