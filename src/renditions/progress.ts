import type { RenditionVideoEncoder } from "./encoding";

export interface RenditionSourceSummary {
  width: number;
  height: number;
  qualityHeight: number;
  durationSeconds: number;
  videoCodec: string;
  isHdr: boolean;
  audioLanguage?: string;
}

export type RenditionProgressEvent =
  | { type: "encoder-selected"; encoder: RenditionVideoEncoder }
  | {
      type: "item-start";
      index: number;
      total: number;
      mediaId: string;
      relativePath: string;
      source: RenditionSourceSummary;
      pendingQualities: number[];
      reusedQualities: number[];
    }
  | {
      type: "encode-start";
      mediaId: string;
      qualities: number[];
      encoder: RenditionVideoEncoder;
      tonemapHdr: boolean;
      durationSeconds: number;
    }
  | {
      type: "encode-progress";
      mediaId: string;
      processedSeconds: number;
      durationSeconds: number;
      fps?: number;
      speed?: number;
      writtenBytes?: number;
    }
  | {
      type: "quality-ready";
      mediaId: string;
      qualityHeight: number;
      width: number;
      height: number;
      fileSize: number;
      reused: boolean;
    }
  | {
      type: "item-complete";
      mediaId: string;
      relativePath: string;
      status: string;
      elapsedMs: number;
      error?: string;
    }
  | {
      type: "analysis-progress";
      index: number;
      total: number;
      relativePath: string;
    };

export type RenditionProgressReporter = (event: RenditionProgressEvent) => void;

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  const paddedMinutes = String(minutes).padStart(2, "0");
  const paddedSeconds = String(remainder).padStart(2, "0");
  return hours > 0
    ? `${hours}:${paddedMinutes}:${paddedSeconds}`
    : `${paddedMinutes}:${paddedSeconds}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

/**
 * Remaining wall time from FFmpeg's own throughput multiplier, which already
 * accounts for tone mapping and encoder speed.
 */
export function estimateRemainingSeconds(
  processedSeconds: number,
  durationSeconds: number,
  speed: number | undefined,
): number | undefined {
  if (!speed || speed <= 0 || !Number.isFinite(durationSeconds))
    return undefined;
  const remaining = Math.max(0, durationSeconds - processedSeconds);
  return remaining / speed;
}

/**
 * Parses one `-progress pipe:1` block. FFmpeg repeats every key in each block,
 * so the accumulated record is always complete.
 */
export function parseFfmpegProgressFields(fields: Record<string, string>): {
  processedSeconds: number;
  fps?: number;
  speed?: number;
  writtenBytes?: number;
} {
  const outTime = fields.out_time?.trim();
  let processedSeconds = 0;

  if (outTime && /^-?\d+:\d{2}:\d{2}(\.\d+)?$/.test(outTime)) {
    const [hours, minutes, seconds] = outTime.split(":");
    processedSeconds =
      Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  } else {
    // `out_time_ms` has always carried microseconds; `out_time_us` is the
    // unambiguous newer spelling.
    const micros = Number(fields.out_time_us ?? fields.out_time_ms);
    if (Number.isFinite(micros)) processedSeconds = micros / 1_000_000;
  }

  const fps = Number(fields.fps);
  const speed = Number((fields.speed ?? "").replace(/x$/, ""));
  const writtenBytes = Number(fields.total_size);

  return {
    processedSeconds: Math.max(0, processedSeconds),
    ...(Number.isFinite(fps) && fps > 0 ? { fps } : {}),
    ...(Number.isFinite(speed) && speed > 0 ? { speed } : {}),
    ...(Number.isFinite(writtenBytes) && writtenBytes >= 0
      ? { writtenBytes }
      : {}),
  };
}
