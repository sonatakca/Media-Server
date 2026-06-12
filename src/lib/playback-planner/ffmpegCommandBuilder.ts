import { join } from "node:path";
import type { MediaAnalysis, PlaybackPlan } from "./types";

export interface FfmpegCommandInput {
  plan: PlaybackPlan;
  media: MediaAnalysis;
  outputDir: string;
  ffmpegPath?: string;
}

export interface FfmpegCommand {
  command: string;
  args: string[];
  playlistPath?: string;
}

interface VideoEncoderPreset {
  codec: string;
  args: string[];
}

function selectVideoEncoder(): VideoEncoderPreset {
  return {
    codec: "libx264",
    args: [
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-tune",
      "zerolatency",
      "-g",
      "120",
      "-keyint_min",
      "120",
      "-sc_threshold",
      "0",
    ],
  };
}

function getAudioBitrate(
  media: MediaAnalysis,
  audioStreamIndex?: number,
): string {
  const stream = media.audioStreams.find(
    (audio) => audio.index === audioStreamIndex,
  );

  return stream?.channels && stream.channels > 2 ? "384k" : "192k";
}

function getHlsSegmentExtension(plan: PlaybackPlan): "m4s" | "ts" {
  return plan.container.output === "hls-fmp4" ? "m4s" : "ts";
}

function buildHlsArgs(plan: PlaybackPlan, outputDir: string): string[] {
  const segmentExtension = getHlsSegmentExtension(plan);
  const args = [
    "-f",
    "hls",
    "-hls_time",
    plan.mode === "video-transcode" || plan.mode === "subtitle-burn"
      ? "2"
      : "4",
    "-hls_flags",
    plan.mode === "video-transcode" || plan.mode === "subtitle-burn"
      ? "delete_segments+independent_segments"
      : "independent_segments",
  ];

  if (plan.mode === "video-transcode" || plan.mode === "subtitle-burn") {
    args.push("-hls_list_size", "5");
  }

  if (plan.container.output === "hls-fmp4") {
    args.push(
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
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
    "-i",
    media.filePath,
    ...buildMapArgs(plan),
  ];

  if (plan.video.action === "copy") {
    args.push("-c:v", "copy");
  } else {
    const encoder = selectVideoEncoder();

    args.push(...encoder.args);

    if (plan.mode === "subtitle-burn") {
      args.push(
        "-vf",
        `subtitles='${escapeSubtitleFilterPath(media.filePath)}':si=${subtitleOrdinal(
          media,
          plan.selected.subtitleStreamIndex,
        )}`,
      );
    }
  }

  if (plan.audio.action === "copy") {
    args.push("-c:a", "copy");
  } else if (plan.audio.action === "transcode") {
    args.push(
      "-c:a",
      "aac",
      "-b:a",
      getAudioBitrate(media, plan.selected.audioStreamIndex),
    );
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
