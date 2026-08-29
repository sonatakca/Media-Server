import { join } from "node:path";
import {
  buildGopArgs,
  SEGMENT_TARGET_SECONDS,
  type GopEncoderFamily,
} from "./gopPolicy";
import type { FfmpegRuntimeProfile, H264VideoEncoder } from "./ffmpegRuntime";
import type { MediaAnalysis, PlaybackPlan } from "./types";

export interface FfmpegCommandInput {
  plan: PlaybackPlan;
  media: MediaAnalysis;
  outputDir: string;
  ffmpegPath?: string;
  runtimeProfile?: FfmpegRuntimeProfile;
}

export interface FfmpegCommand {
  command: string;
  args: string[];
  playlistPath?: string;
}

export class PlaybackConversionUnavailableError extends Error {
  readonly code = "PLAYBACK_CONVERSION_UNAVAILABLE";
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "PlaybackConversionUnavailableError";
  }
}

interface VideoEncoderPreset {
  codec: string;
  args: string[];
}

const HLS_VIDEO_SEGMENT_SECONDS = SEGMENT_TARGET_SECONDS;
const HLS_COPY_SEGMENT_SECONDS = 4;

function getTargetVideoBitrate(
  media: MediaAnalysis,
  videoStreamIndex: number,
): number {
  const video =
    media.videoStreams.find((stream) => stream.index === videoStreamIndex) ??
    media.videoStreams[0];
  const sourceBitrate = video?.bitrate ?? media.overallBitrate;
  const pixelCount = (video?.width ?? 1920) * (video?.height ?? 1080);
  const resolutionTarget =
    pixelCount >= 3840 * 2160
      ? 16_000_000
      : pixelCount >= 1920 * 1080
        ? 8_000_000
        : pixelCount >= 1280 * 720
          ? 4_000_000
          : 2_000_000;

  if (!sourceBitrate || sourceBitrate <= 0) {
    return resolutionTarget;
  }

  return Math.max(
    1_000_000,
    Math.min(resolutionTarget, Math.floor(sourceBitrate * 0.9)),
  );
}

function getRateControlArgs(
  media: MediaAnalysis,
  videoStreamIndex: number,
): string[] {
  const targetBitrate = getTargetVideoBitrate(media, videoStreamIndex);

  return [
    "-b:v",
    String(targetBitrate),
    "-maxrate",
    String(Math.floor(targetBitrate * 1.35)),
    "-bufsize",
    String(targetBitrate * 2),
  ];
}

/**
 * The two-second random-access policy, taken from the shared definition.
 *
 * The live path and the offline packager must cut on the same instants, so the
 * arithmetic and the encoder-specific flags live in `gopPolicy` rather than
 * being restated here. `-pix_fmt yuv420p` stays local: it is a live-transcode
 * compatibility choice, not part of the keyframe policy.
 */
function getVideoTranscodeGopArgs(
  media: MediaAnalysis,
  videoStreamIndex: number,
  encoder: H264VideoEncoder,
): string[] {
  const video =
    media.videoStreams.find((stream) => stream.index === videoStreamIndex) ??
    media.videoStreams[0];

  return [
    ...buildGopArgs({
      encoder: encoder as GopEncoderFamily,
      frameRate: video?.framerate,
      segmentSeconds: HLS_VIDEO_SEGMENT_SECONDS,
    }),
    "-pix_fmt",
    "yuv420p",
  ];
}

function selectVideoEncoder(
  encoder: H264VideoEncoder,
  media: MediaAnalysis,
  videoStreamIndex: number,
  softwareThreads: number,
): VideoEncoderPreset {
  const rateControlArgs = getRateControlArgs(media, videoStreamIndex);
  const gopArgs = getVideoTranscodeGopArgs(media, videoStreamIndex, encoder);

  switch (encoder) {
    case "h264_videotoolbox":
      return {
        codec: encoder,
        args: [
          "-c:v",
          encoder,
          "-realtime",
          "1",
          "-allow_sw",
          "0",
          ...rateControlArgs,
          ...gopArgs,
        ],
      };

    case "h264_nvenc":
      return {
        codec: encoder,
        args: [
          "-c:v",
          encoder,
          "-preset",
          "p4",
          "-tune",
          "ll",
          "-rc",
          "vbr",
          ...rateControlArgs,
          ...gopArgs,
        ],
      };

    case "h264_qsv":
      return {
        codec: encoder,
        args: [
          "-c:v",
          encoder,
          "-preset",
          "veryfast",
          "-async_depth",
          "4",
          ...rateControlArgs,
          ...gopArgs,
        ],
      };

    case "h264_amf":
      return {
        codec: encoder,
        args: [
          "-c:v",
          encoder,
          "-quality",
          "speed",
          "-usage",
          "transcoding",
          "-rc",
          "vbr_peak",
          ...rateControlArgs,
          ...gopArgs,
        ],
      };

    case "libx264":
    default:
      return {
        codec: "libx264",
        args: [
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-tune",
          "zerolatency",
          "-threads",
          String(Math.max(1, softwareThreads)),
          ...gopArgs,
        ],
      };
  }
}

function getHlsSegmentExtension(plan: PlaybackPlan): "m4s" | "ts" {
  return plan.container.output === "hls-fmp4" ? "m4s" : "ts";
}

function buildHlsArgs(plan: PlaybackPlan, outputDir: string): string[] {
  const segmentExtension = getHlsSegmentExtension(plan);
  const isVideoEncoding =
    plan.mode === "video-transcode" || plan.mode === "subtitle-burn";
  const segmentDuration = isVideoEncoding
    ? HLS_VIDEO_SEGMENT_SECONDS
    : HLS_COPY_SEGMENT_SECONDS;

  const args = [
    "-f",
    "hls",
    "-hls_time",
    String(segmentDuration),
    "-hls_flags",
    isVideoEncoding
      ? "delete_segments+independent_segments"
      : "independent_segments",
  ];

  if (isVideoEncoding) {
    args.push("-hls_list_size", "5");
  } else {
    // Ephemeral sessions must publish as soon as the first segment is ready.
    // FFmpeg's VOD mode may withhold the playlist until the full input has been
    // processed, turning an audio switch into a whole-film startup wait. EVENT
    // keeps every segment from zero (unlike the default five-segment live
    // window), grows monotonically while FFmpeg works, and gains ENDLIST when
    // the process completes. Safari can therefore attach the replacement
    // immediately without losing arbitrary seekability once the target range
    // has been generated.
    args.push("-hls_playlist_type", "event");
  }

  if (plan.container.output === "hls-fmp4") {
    args.push(
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      // FFmpeg resolves this value relative to the media playlist. Passing an
      // absolute path makes the HLS muxer prepend the playlist directory a
      // second time ("/output//output/init.mp4") and breaks every live remux.
      "init.mp4",
    );
  }

  args.push(
    "-hls_segment_filename",
    join(outputDir, `segment_%05d.${segmentExtension}`),
    join(outputDir, "master.m3u8"),
  );

  return args;
}

function subtitleOrdinal(media: MediaAnalysis, subtitleStreamIndex?: number) {
  if (subtitleStreamIndex === undefined) {
    return 0;
  }

  const ordinal = media.subtitleStreams.findIndex(
    (subtitle) => subtitle.index === subtitleStreamIndex,
  );

  return ordinal >= 0 ? ordinal : 0;
}

function escapeSubtitleFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function buildVideoFilter(
  plan: PlaybackPlan,
  media: MediaAnalysis,
  runtimeProfile: FfmpegRuntimeProfile,
): string | undefined {
  const filters: string[] = [];
  const video = media.videoStreams.find(
    (stream) => stream.index === plan.selected.videoStreamIndex,
  );

  if (video?.isHdr || video?.hasDolbyVision) {
    if (!runtimeProfile.supportsHdrToneMapping) {
      throw new PlaybackConversionUnavailableError(
        "This server cannot safely convert HDR for this device because its FFmpeg build lacks the required HDR tone-mapping filters.",
      );
    }

    filters.push(
      "zscale=t=linear:npl=100",
      "format=gbrpf32le",
      "zscale=p=bt709",
      "tonemap=hable:desat=0",
      "zscale=t=bt709:m=bt709:r=tv",
      "format=yuv420p",
    );
  }

  if (plan.mode === "subtitle-burn") {
    filters.push(
      `subtitles='${escapeSubtitleFilterPath(media.filePath)}':si=${subtitleOrdinal(
        media,
        plan.selected.subtitleStreamIndex,
      )}`,
    );
  }

  return filters.length > 0 ? filters.join(",") : undefined;
}

function buildMapArgs(plan: PlaybackPlan): string[] {
  const args = ["-map", `0:${plan.selected.videoStreamIndex}`];

  if (plan.selected.audioStreamIndex !== undefined) {
    args.push("-map", `0:${plan.selected.audioStreamIndex}`);
  }

  return args;
}

export function buildFfmpegCommand({
  plan,
  media,
  outputDir,
  ffmpegPath = "ffmpeg",
  runtimeProfile = {
    videoEncoder: "libx264",
    hardwareAccelerated: false,
    softwareThreads: 4,
    availableVideoEncoders: ["libx264"],
    supportsHdrToneMapping: false,
  },
}: FfmpegCommandInput): FfmpegCommand {
  if (!plan.requiresFfmpeg) {
    return {
      command: "",
      args: [],
    };
  }

  const args = [
    "-hide_banner",
    "-y",
    "-nostdin",
    "-filter_threads",
    String(Math.max(1, runtimeProfile.softwareThreads)),
    "-i",
    media.filePath,
    ...buildMapArgs(plan),
  ];

  if (plan.video.action === "copy") {
    args.push("-c:v", "copy");
  } else {
    const encoder = selectVideoEncoder(
      runtimeProfile.videoEncoder,
      media,
      plan.selected.videoStreamIndex,
      runtimeProfile.softwareThreads,
    );
    const videoFilter = buildVideoFilter(plan, media, runtimeProfile);

    args.push(...encoder.args);

    if (videoFilter) {
      args.push("-vf", videoFilter);
    }
  }

  if (plan.audio.action === "copy") {
    args.push("-c:a", "copy");
  } else if (plan.audio.action === "transcode") {
    args.push("-c:a", "aac", "-b:a", "192k", "-ac", "2");
  } else {
    args.push("-an");
  }

  args.push(...buildHlsArgs(plan, outputDir));

  return {
    command: ffmpegPath,
    args,
    playlistPath: join(outputDir, "master.m3u8"),
  };
}
