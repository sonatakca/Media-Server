import { spawn } from "node:child_process";

export type RenditionVideoEncoder = "libx264" | "h264_qsv";
export type RenditionEncoderPreference = "auto" | "qsv" | "software";

export interface RenditionEncodingPolicy {
  crf: number;
  /**
   * Intel QuickSync ICQ quality. QSV is less efficient per bit than x264 at the
   * same nominal quality, so each class sits a couple of steps tighter than its
   * CRF to land on comparable output sizes.
   */
  globalQuality: number;
  /** Hard rate cap handed to the encoder; only busy scenes ever reach it. */
  maxVideoBitrate: number;
  /**
   * Typical CRF output rate for live-action content at this height. Storage
   * planning uses this rather than `maxVideoBitrate`, which would roughly double
   * every estimate and defer titles that comfortably fit. The processor still
   * re-checks real free space before every title, so an optimistic plan can
   * never overfill the drive.
   */
  expectedVideoBitrate: number;
  audioBitrate: number;
}

const ENCODING_POLICY: Record<number, RenditionEncodingPolicy> = {
  1080: {
    crf: 20,
    globalQuality: 22,
    maxVideoBitrate: 10_000_000,
    expectedVideoBitrate: 5_500_000,
    audioBitrate: 384_000,
  },
  720: {
    crf: 21,
    globalQuality: 23,
    maxVideoBitrate: 5_000_000,
    expectedVideoBitrate: 3_000_000,
    audioBitrate: 256_000,
  },
  480: {
    crf: 22,
    globalQuality: 24,
    maxVideoBitrate: 2_500_000,
    expectedVideoBitrate: 1_400_000,
    audioBitrate: 192_000,
  },
};

/**
 * PQ/HLG to SDR BT.709. Without this an HDR master is simply truncated to 8-bit
 * BT.709 and the result looks grey and desaturated. `npl=100` targets a 100-nit
 * SDR display and Hable keeps highlight roll-off gentle. Needs libzimg.
 */
const HDR_TO_SDR_FILTER = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
].join(",");

export interface RenditionOutputRequest {
  /** Standard quality class (1080/720/480) that selects the rate policy. */
  qualityHeight: number;
  /** Actual encoded pixel dimensions, preserving the source aspect ratio. */
  width: number;
  height: number;
  outputPath: string;
}

export interface RenditionEncodingInput {
  inputPath: string;
  /** Every rendition produced from a single decode of the source. */
  outputs: RenditionOutputRequest[];
  audioStreamIndex: number;
  audioLanguage?: string;
  encoder?: RenditionVideoEncoder;
  /** Set when the source is PQ or HLG and must be tone mapped to SDR. */
  tonemapHdr?: boolean;
  preset?: string;
}

export function getEncodingPolicy(
  qualityHeight: number,
): RenditionEncodingPolicy {
  const policy = ENCODING_POLICY[qualityHeight];
  if (!policy)
    throw new Error(`Unsupported rendition quality: ${qualityHeight}p`);
  return policy;
}

function levelFor(qualityHeight: number): string {
  return qualityHeight >= 1080 ? "4.1" : qualityHeight >= 720 ? "3.1" : "3.0";
}

function videoEncoderArgs(
  encoder: RenditionVideoEncoder,
  qualityHeight: number,
  preset: string,
): string[] {
  const policy = getEncodingPolicy(qualityHeight);
  const shared = [
    "-maxrate",
    String(policy.maxVideoBitrate),
    "-bufsize",
    String(policy.maxVideoBitrate * 2),
    "-profile:v",
    "high",
    "-level:v",
    levelFor(qualityHeight),
  ];

  if (encoder === "h264_qsv") {
    return [
      "-c:v",
      "h264_qsv",
      "-preset",
      preset,
      "-global_quality",
      String(policy.globalQuality),
      ...shared,
    ];
  }

  return [
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(policy.crf),
    ...shared,
  ];
}

/**
 * Builds one filter graph that decodes the source once, tone maps once when
 * needed, then splits into every requested rendition. Decoding a 4K master
 * separately per rendition was the dominant cost of the previous per-file passes.
 */
export function buildRenditionFilterComplex({
  outputs,
  encoder = "libx264",
  tonemapHdr = false,
}: Pick<RenditionEncodingInput, "outputs" | "encoder" | "tonemapHdr">): string {
  if (outputs.length === 0) {
    throw new Error("At least one rendition output is required.");
  }

  const pixelFormat = encoder === "h264_qsv" ? "nv12" : "yuv420p";
  const chains: string[] = [];
  let head = "0:v:0";

  if (tonemapHdr) {
    chains.push(`[${head}]${HDR_TO_SDR_FILTER}[tonemapped]`);
    head = "tonemapped";
  }

  if (outputs.length > 1) {
    const branches = outputs.map((_, index) => `split${index}`);
    chains.push(
      `[${head}]split=${outputs.length}${branches.map((label) => `[${label}]`).join("")}`,
    );
    outputs.forEach((output, index) => {
      chains.push(
        `[${branches[index]}]scale=${output.width}:${output.height}:flags=lanczos,format=${pixelFormat}[out${index}]`,
      );
    });
  } else {
    chains.push(
      `[${head}]scale=${outputs[0].width}:${outputs[0].height}:flags=lanczos,format=${pixelFormat}[out0]`,
    );
  }

  return chains.join(";");
}

export function buildRenditionFfmpegArgs({
  inputPath,
  outputs,
  audioStreamIndex,
  audioLanguage,
  encoder = "libx264",
  tonemapHdr = false,
  preset = "medium",
}: RenditionEncodingInput): string[] {
  if (outputs.length === 0) {
    throw new Error("At least one rendition output is required.");
  }

  const args = [
    "-hide_banner",
    "-nostdin",
    // Machine-readable progress on stdout instead of the per-frame stderr
    // spam, so a multi-hour title can report where it is.
    "-progress",
    "pipe:1",
    "-nostats",
    "-n",
    "-i",
    inputPath,
    "-filter_complex",
    buildRenditionFilterComplex({ outputs, encoder, tonemapHdr }),
  ];

  outputs.forEach((output, index) => {
    const policy = getEncodingPolicy(output.qualityHeight);
    args.push(
      "-map",
      `[out${index}]`,
      "-map",
      `0:${audioStreamIndex}`,
      "-sn",
      "-dn",
      ...videoEncoderArgs(encoder, output.qualityHeight, preset),
      "-metadata:s:v:0",
      "rotate=0",
      "-c:a",
      "aac",
      "-b:a",
      String(policy.audioBitrate),
      "-ar",
      "48000",
      "-disposition:a:0",
      "default",
      ...(audioLanguage
        ? ["-metadata:s:a:0", `language=${audioLanguage}`]
        : []),
      "-max_muxing_queue_size",
      "2048",
      "-movflags",
      "+faststart",
      output.outputPath,
    );
  });

  return args;
}

export function parseEncoderPreference(
  value: string | undefined,
): RenditionEncoderPreference {
  const preference = value?.trim().toLowerCase();
  if (!preference || preference === "auto") return "auto";
  if (preference === "qsv" || preference === "software") return preference;
  throw new Error(
    "SEYIRLIK_RENDITION_ENCODER must be `auto`, `qsv` or `software`.",
  );
}

/**
 * QuickSync appearing in `-encoders` does not mean a usable device is present,
 * so availability is decided by actually encoding a throwaway frame.
 */
export async function detectQuickSyncSupport(
  ffmpegPath: string,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=128x128:d=0.1,format=nv12",
        "-c:v",
        "h264_qsv",
        "-f",
        "null",
        "-",
      ],
      { shell: false, windowsHide: true, stdio: "ignore", signal },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export async function resolveVideoEncoder(
  preference: RenditionEncoderPreference,
  ffmpegPath: string,
  signal?: AbortSignal,
): Promise<RenditionVideoEncoder> {
  if (preference === "software") return "libx264";

  const supported = await detectQuickSyncSupport(ffmpegPath, signal);

  if (supported) return "h264_qsv";
  if (preference === "qsv") {
    throw new Error(
      "SEYIRLIK_RENDITION_ENCODER=qsv was requested but no usable QuickSync encoder is available.",
    );
  }
  return "libx264";
}
