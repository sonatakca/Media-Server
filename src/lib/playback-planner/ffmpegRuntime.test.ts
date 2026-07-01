// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  detectFfmpegRuntime,
  parseFfmpegFilters,
  parseFfmpegVideoEncoders,
  selectH264VideoEncoder,
} from "./ffmpegRuntime";

const ENCODER_OUTPUT = `
Encoders:
 V..... h264_videotoolbox VideoToolbox H.264 Encoder
 V....D h264_nvenc NVIDIA NVENC H.264 encoder
 V..... h264_qsv H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10
 V....D libx264 libx264 H.264 / AVC
`;
const FILTER_OUTPUT = `
 ... zscale            V->V       Apply resizing, colorspace and bit depth conversion.
 .S. tonemap           V->V       Conversion to/from different dynamic ranges.
`;

describe("FFmpeg runtime selection", () => {
  it("parses video encoder names", () => {
    expect(parseFfmpegVideoEncoders(ENCODER_OUTPUT)).toEqual(
      new Set([
        "h264_videotoolbox",
        "h264_nvenc",
        "h264_qsv",
        "libx264",
      ]),
    );
  });

  it("prefers VideoToolbox on macOS", () => {
    const available = parseFfmpegVideoEncoders(ENCODER_OUTPUT);

    expect(selectH264VideoEncoder(available, "auto", "darwin")).toBe(
      "h264_videotoolbox",
    );
  });

  it("detects the complete HDR tone-map filter chain", () => {
    expect(parseFfmpegFilters(FILTER_OUTPUT)).toEqual(
      new Set(["zscale", "tonemap"]),
    );
  });

  it("prefers NVENC on Windows and Linux", () => {
    const available = parseFfmpegVideoEncoders(ENCODER_OUTPUT);

    expect(selectH264VideoEncoder(available, "auto", "win32")).toBe(
      "h264_nvenc",
    );
    expect(selectH264VideoEncoder(available, "auto", "linux")).toBe(
      "h264_nvenc",
    );
  });

  it("honors a software override and thread bound", async () => {
    const profile = await detectFfmpegRuntime({
      encoderOutput: ENCODER_OUTPUT,
      filterOutput: FILTER_OUTPUT,
      preferredVideoEncoder: "software",
      softwareThreads: 3,
      platform: "darwin",
    });

    expect(profile).toMatchObject({
      videoEncoder: "libx264",
      hardwareAccelerated: false,
      softwareThreads: 3,
      supportsHdrToneMapping: true,
    });
  });
});
