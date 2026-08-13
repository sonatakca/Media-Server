/**
 * Measurement of a packaged rendition, taken from the bytes that were written.
 *
 * Everything the manifest claims about a rendition is measured here rather than
 * copied from the encode request. That distinction matters: a request says what
 * was asked for, and validation that compares a package against the request can
 * only ever prove FFmpeg was invoked correctly. Comparing it against a probe of
 * the output proves the output is what it claims to be, which is the property
 * the player actually depends on.
 */

import { spawn } from "node:child_process";

export interface PackagedVideoProbe {
  codec: string;
  codecTag: string;
  profile?: string;
  level?: string;
  width: number;
  height: number;
  pixelFormat: string;
  frameRate: number;
  durationSeconds: number;
  sizeBytes: number;
  colorPrimaries?: string;
  colorTransfer?: string;
  colorSpace?: string;
  /** Presentation timestamps of every random-access frame, in order. */
  keyframeTimes: number[];
}

export interface PackagedAudioProbe {
  codec: string;
  profile?: string;
  channels: number;
  sampleRate: number;
  durationSeconds: number;
  sizeBytes: number;
}

interface FfprobeJson {
  streams?: Array<Record<string, unknown>>;
  format?: Record<string, unknown>;
}

const MAX_FFPROBE_OUTPUT_BYTES = 32 * 1024 * 1024;

function runFfprobe(
  ffprobePath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, args, {
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as string);
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
      if (stdout.length > MAX_FFPROBE_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("FFprobe output exceeded the safe limit."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
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
      finish(undefined, stdout);
    });
  });
}

function numberOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : undefined;
}

function rationalFrameRate(value: unknown): number | undefined {
  const text = stringOf(value);
  if (!text || text === "0/0") return undefined;
  const [numerator, denominator = "1"] = text.split("/");
  const top = Number(numerator);
  const bottom = Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= 0) {
    return undefined;
  }
  const frameRate = top / bottom;
  return frameRate > 0 ? frameRate : undefined;
}

/**
 * Keyframe presentation times.
 *
 * `-skip_frame nokey` makes the decoder discard everything that is not a
 * random-access frame, so a two-hour rendition reports a few thousand lines
 * instead of a few hundred thousand packets. That difference is what keeps
 * validating a full library from being dominated by ffprobe output parsing.
 */
export async function probeKeyframeTimes(
  mediaPath: string,
  ffprobePath: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const output = await runFfprobe(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-skip_frame",
      "nokey",
      "-show_entries",
      "frame=pts_time",
      "-of",
      "csv=p=0",
      mediaPath,
    ],
    signal,
  );

  return (
    output
      .split(/\r?\n/)
      .map((line) => line.split(",")[0]?.trim() ?? "")
      // Empty lines have to be dropped before conversion: `Number("")` is 0, not
      // NaN, so the trailing newline every ffprobe run emits would otherwise
      // appear as a keyframe at the start of the timeline.
      .filter((field) => field !== "" && field.toUpperCase() !== "N/A")
      .map((field) => Number(field))
      .filter((value) => Number.isFinite(value))
  );
}

export async function probePackagedVideo(
  mediaPath: string,
  ffprobePath: string,
  signal?: AbortSignal,
): Promise<PackagedVideoProbe> {
  const [raw, keyframeTimes] = await Promise.all([
    runFfprobe(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,codec_tag_string,profile,level,width,height,pix_fmt,avg_frame_rate,r_frame_rate,color_primaries,color_transfer,color_space:format=duration,size",
        "-of",
        "json",
        mediaPath,
      ],
      signal,
    ),
    probeKeyframeTimes(mediaPath, ffprobePath, signal),
  ]);

  const parsed = JSON.parse(raw) as FfprobeJson;
  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error(`Packaged rendition has no video stream: ${mediaPath}`);
  }

  const width = numberOf(stream.width);
  const height = numberOf(stream.height);
  const durationSeconds = numberOf(parsed.format?.duration);
  const sizeBytes = numberOf(parsed.format?.size);
  const frameRate =
    rationalFrameRate(stream.avg_frame_rate) ??
    rationalFrameRate(stream.r_frame_rate);

  if (
    width === undefined ||
    height === undefined ||
    durationSeconds === undefined ||
    sizeBytes === undefined ||
    frameRate === undefined
  ) {
    throw new Error(
      `Packaged rendition is missing basic video properties: ${mediaPath}`,
    );
  }

  const level = numberOf(stream.level);

  return {
    codec: (stringOf(stream.codec_name) ?? "unknown").toLowerCase(),
    codecTag: (stringOf(stream.codec_tag_string) ?? "").toLowerCase(),
    ...(stringOf(stream.profile) === undefined
      ? {}
      : { profile: stringOf(stream.profile) as string }),
    ...(level === undefined || level < 0 ? {} : { level: String(level) }),
    width,
    height,
    pixelFormat: stringOf(stream.pix_fmt) ?? "unknown",
    frameRate,
    durationSeconds,
    sizeBytes,
    ...(stringOf(stream.color_primaries) === undefined
      ? {}
      : { colorPrimaries: stringOf(stream.color_primaries) as string }),
    ...(stringOf(stream.color_transfer) === undefined
      ? {}
      : { colorTransfer: stringOf(stream.color_transfer) as string }),
    ...(stringOf(stream.color_space) === undefined
      ? {}
      : { colorSpace: stringOf(stream.color_space) as string }),
    keyframeTimes,
  };
}

export async function probePackagedAudio(
  mediaPath: string,
  ffprobePath: string,
  signal?: AbortSignal,
): Promise<PackagedAudioProbe> {
  const raw = await runFfprobe(
    ffprobePath,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_name,profile,channels,sample_rate:format=duration,size",
      "-of",
      "json",
      mediaPath,
    ],
    signal,
  );

  const parsed = JSON.parse(raw) as FfprobeJson;
  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error(`Packaged rendition has no audio stream: ${mediaPath}`);
  }

  const channels = numberOf(stream.channels);
  const sampleRate = numberOf(stream.sample_rate);
  const durationSeconds = numberOf(parsed.format?.duration);
  const sizeBytes = numberOf(parsed.format?.size);

  if (
    channels === undefined ||
    sampleRate === undefined ||
    durationSeconds === undefined ||
    sizeBytes === undefined
  ) {
    throw new Error(
      `Packaged rendition is missing basic audio properties: ${mediaPath}`,
    );
  }

  return {
    codec: (stringOf(stream.codec_name) ?? "unknown").toLowerCase(),
    ...(stringOf(stream.profile) === undefined
      ? {}
      : { profile: stringOf(stream.profile) as string }),
    channels,
    sampleRate,
    durationSeconds,
    sizeBytes,
  };
}

/**
 * RFC 6381 audio codec string.
 *
 * FFmpeg's generated master carries the video strings, which are the ones that
 * cannot be derived safely from a profile name, but the audio side is a short
 * closed set and is mapped here so the audio-only case does not depend on the
 * muxer having written a variant that mentions it.
 */
export function audioCodecString(probe: PackagedAudioProbe): string {
  if (probe.codec !== "aac") {
    throw new Error(`Unsupported adaptive audio codec: ${probe.codec}`);
  }
  const profile = probe.profile?.toUpperCase() ?? "LC";
  if (profile.includes("HE-AAC") && profile.includes("V2")) return "mp4a.40.29";
  if (profile.includes("HE-AAC")) return "mp4a.40.5";
  return "mp4a.40.2";
}
