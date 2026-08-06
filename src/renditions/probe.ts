import { spawn } from "node:child_process";

interface FfprobeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string | number;
  bits_per_raw_sample?: string | number;
  pix_fmt?: string;
  tags?: Record<string, string | undefined>;
  disposition?: Record<string, number | undefined>;
  side_data_list?: Array<Record<string, unknown>>;
  channels?: number;
}

interface FfprobeChapter {
  id?: number;
  start_time?: string | number;
  end_time?: string | number;
  tags?: Record<string, string | undefined>;
}

export interface RenditionFfprobeOutput {
  format?: {
    duration?: string | number;
    bit_rate?: string | number;
  };
  streams?: FfprobeStream[];
  chapters?: FfprobeChapter[];
}

export interface RenditionVideoProbe {
  streamIndex: number;
  codec: string;
  width: number;
  height: number;
  rotation: number;
  frameRate?: number;
  bitrate?: number;
  bitDepth?: number;
  pixelFormat?: string;
}

export interface RenditionAudioTrackProbe {
  streamIndex: number;
  codec: string;
  channels?: number;
  language?: string;
  title?: string;
  isDefault: boolean;
}

export interface RenditionSubtitleTrackProbe {
  streamIndex: number;
  codec: string;
  language?: string;
  title?: string;
  isDefault: boolean;
  isForced: boolean;
}

export interface RenditionMediaProbe {
  durationSeconds: number;
  overallBitrate?: number;
  video: RenditionVideoProbe;
  audioTracks: RenditionAudioTrackProbe[];
  subtitleTracks: RenditionSubtitleTrackProbe[];
  chapters: Array<{
    id?: number;
    startSeconds: number;
    endSeconds: number;
    title?: string;
  }>;
}

function numberValue(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function frameRateValue(value: string | undefined): number | undefined {
  if (!value || value === "0/0") return undefined;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator =
    denominatorText === undefined ? 1 : Number(denominatorText);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return undefined;
  }
  const frameRate = numerator / denominator;
  return frameRate > 0 ? frameRate : undefined;
}

function rotationValue(stream: FfprobeStream): number {
  const tagRotation = numberValue(stream.tags?.rotate);
  const sideDataRotation = stream.side_data_list
    ?.map((entry) => numberValue(entry.rotation as string | number | undefined))
    .find((rotation) => rotation !== undefined);
  const rawRotation = sideDataRotation ?? tagRotation ?? 0;
  const normalized = ((Math.round(rawRotation) % 360) + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270
    ? normalized
    : 0;
}

function bitDepthValue(stream: FfprobeStream): number | undefined {
  const explicit = numberValue(stream.bits_per_raw_sample);
  if (explicit && explicit > 0) return explicit;
  const pixelFormat = stream.pix_fmt?.toLowerCase();
  if (!pixelFormat) return undefined;
  const match = pixelFormat.match(/(?:p|yuv\d+p)(10|12|14|16)(?:le|be)?/);
  if (match?.[1]) return Number(match[1]);
  return 8;
}

export function parseRenditionProbe(
  output: RenditionFfprobeOutput,
): RenditionMediaProbe {
  const streams = Array.isArray(output.streams) ? output.streams : [];
  const videoStream = streams.find(
    (stream) =>
      stream.codec_type === "video" &&
      Number.isFinite(stream.width) &&
      Number.isFinite(stream.height) &&
      (stream.width ?? 0) > 0 &&
      (stream.height ?? 0) > 0,
  );

  if (!videoStream) {
    throw new Error("FFprobe output does not contain a usable video stream.");
  }

  return {
    durationSeconds: numberValue(output.format?.duration) ?? 0,
    overallBitrate: numberValue(output.format?.bit_rate),
    video: {
      streamIndex: videoStream.index ?? 0,
      codec: (videoStream.codec_name ?? "unknown").toLowerCase(),
      width: videoStream.width ?? 0,
      height: videoStream.height ?? 0,
      rotation: rotationValue(videoStream),
      frameRate:
        frameRateValue(videoStream.avg_frame_rate) ??
        frameRateValue(videoStream.r_frame_rate),
      bitrate: numberValue(videoStream.bit_rate),
      bitDepth: bitDepthValue(videoStream),
      pixelFormat: videoStream.pix_fmt,
    },
    audioTracks: streams
      .filter((stream) => stream.codec_type === "audio")
      .map((stream) => ({
        streamIndex: stream.index ?? 0,
        codec: (stream.codec_name ?? "unknown").toLowerCase(),
        channels: stream.channels,
        language: stream.tags?.language,
        title: stream.tags?.title,
        isDefault: stream.disposition?.default === 1,
      })),
    subtitleTracks: streams
      .filter((stream) => stream.codec_type === "subtitle")
      .map((stream) => ({
        streamIndex: stream.index ?? 0,
        codec: (stream.codec_name ?? "unknown").toLowerCase(),
        language: stream.tags?.language,
        title: stream.tags?.title,
        isDefault: stream.disposition?.default === 1,
        isForced: stream.disposition?.forced === 1,
      })),
    chapters: (output.chapters ?? []).map((chapter) => ({
      id: chapter.id,
      startSeconds: numberValue(chapter.start_time) ?? 0,
      endSeconds: numberValue(chapter.end_time) ?? 0,
      title: chapter.tags?.title,
    })),
  };
}

export async function probeMediaFile(
  filePath: string,
  ffprobePath = process.env.FFPROBE_PATH ??
    process.env.SEYIRLIK_FFPROBE_PATH ??
    "ffprobe",
  signal?: AbortSignal,
): Promise<RenditionMediaProbe> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobePath,
      [
        "-v",
        "error",
        "-show_format",
        "-show_streams",
        "-show_chapters",
        "-print_format",
        "json",
        filePath,
      ],
      { shell: false, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, result?: RenditionMediaProbe) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result as RenditionMediaProbe);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("FFprobe was cancelled."));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 16 * 1024 * 1024) {
        child.kill("SIGTERM");
        finish(new Error("FFprobe output exceeded the safe limit."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_384);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(
            `FFprobe failed with exit code ${code ?? "unknown"}: ${stderr}`,
          ),
        );
        return;
      }
      try {
        finish(
          undefined,
          parseRenditionProbe(JSON.parse(stdout) as RenditionFfprobeOutput),
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
