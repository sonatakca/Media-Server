export interface RenditionEncodingPolicy {
  crf: number;
  /** Hard rate cap handed to x264; only busy scenes ever reach it. */
  maxVideoBitrate: number;
  /**
   * Typical CRF output rate for live-action content at this height. Storage
   * planning uses this rather than `maxVideoBitrate`, which would roughly double
   * every estimate and defer titles that comfortably fit. The processor still
   * re-checks real free space before every single file, so an optimistic plan
   * can never overfill the drive.
   */
  expectedVideoBitrate: number;
  audioBitrate: number;
}

const ENCODING_POLICY: Record<number, RenditionEncodingPolicy> = {
  1080: {
    crf: 20,
    maxVideoBitrate: 10_000_000,
    expectedVideoBitrate: 5_500_000,
    audioBitrate: 384_000,
  },
  720: {
    crf: 21,
    maxVideoBitrate: 5_000_000,
    expectedVideoBitrate: 3_000_000,
    audioBitrate: 256_000,
  },
  480: {
    crf: 22,
    maxVideoBitrate: 2_500_000,
    expectedVideoBitrate: 1_400_000,
    audioBitrate: 192_000,
  },
};

export interface RenditionEncodingInput {
  inputPath: string;
  outputPath: string;
  /** Standard quality class (1080/720/480) that selects the rate policy. */
  qualityHeight: number;
  /** Actual encoded pixel dimensions, preserving the source aspect ratio. */
  width: number;
  height: number;
  audioStreamIndex: number;
  audioLanguage?: string;
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

export function buildRenditionFfmpegArgs({
  inputPath,
  outputPath,
  qualityHeight,
  width,
  height,
  audioStreamIndex,
  audioLanguage,
  preset = "medium",
}: RenditionEncodingInput): string[] {
  const policy = getEncodingPolicy(qualityHeight);
  return [
    "-hide_banner",
    "-nostdin",
    "-n",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    `0:${audioStreamIndex}`,
    "-sn",
    "-dn",
    "-vf",
    `scale=${width}:${height}:flags=lanczos`,
    "-c:v",
    "libx264",
    "-preset",
    preset,
    "-crf",
    String(policy.crf),
    "-maxrate",
    String(policy.maxVideoBitrate),
    "-bufsize",
    String(policy.maxVideoBitrate * 2),
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level:v",
    qualityHeight >= 1080 ? "4.1" : qualityHeight >= 720 ? "3.1" : "3.0",
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
    ...(audioLanguage ? ["-metadata:s:a:0", `language=${audioLanguage}`] : []),
    "-max_muxing_queue_size",
    "2048",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}
