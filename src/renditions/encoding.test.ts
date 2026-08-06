import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildRenditionFfmpegArgs } from "./encoding";

describe("standalone rendition encoding commands", () => {
  it("builds a shell-free FFmpeg argument array for one complete fast-start MP4", () => {
    const outputPath = path.join(
      "D:\\media",
      ".seyirlik",
      "work",
      "id",
      "480p.partial.mp4",
    );
    const args = buildRenditionFfmpegArgs({
      inputPath: "D:\\media\\Movies\\Çağrı & Film.mkv",
      outputPath,
      qualityHeight: 480,
      width: 854,
      height: 360,
      audioStreamIndex: 2,
      audioLanguage: "tur",
    });

    expect(args[args.length - 1]).toBe(outputPath);
    expect(args).toContain("D:\\media\\Movies\\Çağrı & Film.mkv");
    expect(args).toContain("scale=854:360:flags=lanczos");
    expect(args).toContain("libx264");
    expect(args).toContain("yuv420p");
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    expect(args).toContain("0:2");
    expect(args).toContain("language=tur");
    expect(args).not.toContain("hls");
    expect(
      args.some((argument) => /\.m3u8$|\.m4s$|\.ts$/i.test(argument)),
    ).toBe(false);
    expect(args).not.toContain("sh");
    expect(args).not.toContain("cmd.exe");
  });
});
