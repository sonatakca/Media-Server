import { spawn } from "node:child_process";

export type RenditionCodecFamily = "h264" | "hevc";
export type RenditionVideoEncoder =
  | "libx264"
  | "h264_qsv"
  | "libx265"
  | "hevc_qsv";
export type RenditionEncoderPreference = "auto" | "qsv" | "software";
/**
 * `preserve` keeps an HDR master in HDR, which forces HEVC Main 10 because no
 * browser decodes 10-bit H.264. `tonemap` converts to SDR H.264 instead, which
 * plays everywhere but discards the HDR grade.
 */
export type RenditionHdrPolicy = "preserve" | "tonemap";

export interface RenditionEncodingPolicy {
  crf: number;
  /**
   * QuickSync ICQ quality. QSV is less efficient per bit than the software
   * encoders at the same nominal quality, so each class sits a couple of steps
   * tighter to land on comparable output sizes.
   */
  globalQuality: number;
  /** Hard rate cap handed to the encoder; only busy scenes ever reach it. */
  maxVideoBitrate: number;
  /**
   * Typical output rate for live-action content at this quality class. Storage
   * planning uses this rather than `maxVideoBitrate`, which would roughly double
   * every estimate and defer titles that comfortably fit. The processor still
   * re-checks real free space before every title, so an optimistic plan can
   * never overfill the drive.
   */
  expectedVideoBitrate: number;
  audioBitrate: number;
}

/**
 * HEVC is roughly 35-45% more efficient than H.264, but HDR10 carries a 10-bit
 * wider-gamut signal, so the saving is spent on the extra precision rather than
 * banked. Rates therefore land close to the SDR H.264 ladder.
 */
const ENCODING_POLICY: Record<
  RenditionCodecFamily,
  Record<number, RenditionEncodingPolicy>
> = {
  h264: {
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
  },
  hevc: {
    1080: {
      crf: 22,
      globalQuality: 24,
      maxVideoBitrate: 12_000_000,
      expectedVideoBitrate: 6_000_000,
      audioBitrate: 384_000,
    },
    720: {
      crf: 23,
      globalQuality: 25,
      maxVideoBitrate: 6_000_000,
      expectedVideoBitrate: 3_200_000,
      audioBitrate: 256_000,
    },
    480: {
      crf: 24,
      globalQuality: 26,
      maxVideoBitrate: 3_000_000,
      expectedVideoBitrate: 1_600_000,
      audioBitrate: 192_000,
    },
  },
};

/**
 * PQ/HLG to SDR BT.709, used only when the HDR policy is `tonemap`. Without this
 * an HDR master is simply truncated to 8-bit BT.709 and the result looks grey
 * and desaturated. `npl=100` targets a 100-nit SDR display and Hable keeps
 * highlight roll-off gentle. Needs libzimg.
 */
const HDR_TO_SDR_FILTER = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=tv",
].join(",");

export interface RenditionHdrSignal {
  colorPrimaries: string;
  colorTransfer: string;
  colorSpace: string;
}

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
  /** Present when the HDR grade is being carried through to the output. */
  hdr?: RenditionHdrSignal;
  /** Set when a PQ/HLG source is being converted down to SDR instead. */
  tonemapHdr?: boolean;
  preset?: string;
}

export function codecFamilyForEncoder(
  encoder: RenditionVideoEncoder,
): RenditionCodecFamily {
  return encoder === "libx265" || encoder === "hevc_qsv" ? "hevc" : "h264";
}

export function getEncodingPolicy(
  qualityHeight: number,
  family: RenditionCodecFamily = "h264",
): RenditionEncodingPolicy {
  const policy = ENCODING_POLICY[family][qualityHeight];
  if (!policy)
    throw new Error(`Unsupported rendition quality: ${qualityHeight}p`);
  return policy;
}

function levelFor(qualityHeight: number, family: RenditionCodecFamily): string {
  if (family === "hevc") return qualityHeight >= 1080 ? "4.1" : "4";
  return qualityHeight >= 1080 ? "4.1" : qualityHeight >= 720 ? "3.1" : "3.0";
}

function videoEncoderArgs(
  encoder: RenditionVideoEncoder,
  qualityHeight: number,
  preset: string,
  hdr: RenditionHdrSignal | undefined,
): string[] {
  const family = codecFamilyForEncoder(encoder);
  const policy = getEncodingPolicy(qualityHeight, family);
  const rateCap = [
    "-maxrate",
    String(policy.maxVideoBitrate),
    "-bufsize",
    String(policy.maxVideoBitrate * 2),
  ];
  // HDR10 signalling has to be written explicitly; the filter graph does not
  // carry colour properties through to the encoder on its own.
  const colour = hdr
    ? [
        "-color_primaries",
        hdr.colorPrimaries,
        "-color_trc",
        hdr.colorTransfer,
        "-colorspace",
        hdr.colorSpace,
      ]
    : [];

  if (encoder === "hevc_qsv") {
    return [
      "-c:v",
      "hevc_qsv",
      "-preset",
      preset,
      "-profile:v",
      hdr ? "main10" : "main",
      "-global_quality",
      String(policy.globalQuality),
      ...rateCap,
      ...colour,
      // Safari refuses `hev1`-tagged MP4s; `hvc1` is required for playback.
      "-tag:v",
      "hvc1",
    ];
  }

  if (encoder === "libx265") {
    return [
      "-c:v",
      "libx265",
      "-preset",
      preset,
      "-crf",
      String(policy.crf),
      ...rateCap,
      ...colour,
      "-tag:v",
      "hvc1",
    ];
  }

  const shared = [
    ...rateCap,
    "-profile:v",
    "high",
    "-level:v",
    levelFor(qualityHeight, family),
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

function pixelFormatFor(
  encoder: RenditionVideoEncoder,
  hdr: RenditionHdrSignal | undefined,
): string {
  if (hdr) return encoder === "hevc_qsv" ? "p010le" : "yuv420p10le";
  return encoder === "h264_qsv" || encoder === "hevc_qsv" ? "nv12" : "yuv420p";
}

/**
 * Builds one filter graph that decodes the source once, tone maps once when
 * needed, then splits into every requested rendition. Decoding a 4K master
 * separately per rendition was the dominant cost of the previous per-file passes.
 */
export function buildRenditionFilterComplex({
  outputs,
  encoder = "libx264",
  hdr,
  tonemapHdr = false,
}: Pick<
  RenditionEncodingInput,
  "outputs" | "encoder" | "hdr" | "tonemapHdr"
>): string {
  if (outputs.length === 0) {
    throw new Error("At least one rendition output is required.");
  }

  const pixelFormat = pixelFormatFor(encoder, hdr);
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
  hdr,
  tonemapHdr = false,
  preset = "medium",
}: RenditionEncodingInput): string[] {
  if (outputs.length === 0) {
    throw new Error("At least one rendition output is required.");
  }
  if (hdr && codecFamilyForEncoder(encoder) !== "hevc") {
    throw new Error(
      "Preserving HDR requires an HEVC encoder; no browser decodes 10-bit H.264.",
    );
  }

  const family = codecFamilyForEncoder(encoder);
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
    buildRenditionFilterComplex({ outputs, encoder, hdr, tonemapHdr }),
  ];

  outputs.forEach((output, index) => {
    const policy = getEncodingPolicy(output.qualityHeight, family);
    args.push(
      "-map",
      `[out${index}]`,
      "-map",
      `0:${audioStreamIndex}`,
      "-sn",
      "-dn",
      ...videoEncoderArgs(encoder, output.qualityHeight, preset, hdr),
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

export function parseHdrPolicy(value: string | undefined): RenditionHdrPolicy {
  const policy = value?.trim().toLowerCase();
  if (!policy || policy === "preserve") return "preserve";
  if (policy === "tonemap") return "tonemap";
  throw new Error("SEYIRLIK_RENDITION_HDR must be `preserve` or `tonemap`.");
}

/**
 * A hardware encoder appearing in `-encoders` does not mean a usable device is
 * present, so availability is decided by actually encoding a throwaway frame at
 * the bit depth the profile needs.
 */
export async function detectEncoderSupport(
  ffmpegPath: string,
  encoder: RenditionVideoEncoder,
  tenBit: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  const sourceFormat = tenBit ? "p010" : "nv12";
  const profile =
    encoder === "hevc_qsv" ? ["-profile:v", tenBit ? "main10" : "main"] : [];

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
        `color=c=black:s=128x128:d=0.1,format=${sourceFormat}`,
        "-c:v",
        encoder,
        ...profile,
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
  family: RenditionCodecFamily = "h264",
  tenBit = false,
  signal?: AbortSignal,
): Promise<RenditionVideoEncoder> {
  const hardware: RenditionVideoEncoder =
    family === "hevc" ? "hevc_qsv" : "h264_qsv";
  const software: RenditionVideoEncoder =
    family === "hevc" ? "libx265" : "libx264";

  if (preference === "software") return software;

  const supported = await detectEncoderSupport(
    ffmpegPath,
    hardware,
    tenBit,
    signal,
  );

  if (supported) return hardware;
  if (preference === "qsv") {
    throw new Error(
      `SEYIRLIK_RENDITION_ENCODER=qsv was requested but ${hardware} is not usable on this machine.`,
    );
  }
  return software;
}
