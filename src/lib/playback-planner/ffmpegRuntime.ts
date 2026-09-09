import { spawn } from "node:child_process";
import {
  defaultSoftwareEncoderThreads,
  defaultSoftwareFilterThreads,
} from "../../server/cpuTopology";
import { probeEncoder } from "../../renditions/hardware/adapters";

export const H264_VIDEO_ENCODERS = [
  "h264_videotoolbox",
  "h264_nvenc",
  "h264_qsv",
  "h264_amf",
  "libx264",
] as const;

export type H264VideoEncoder = (typeof H264_VIDEO_ENCODERS)[number];

export interface FfmpegRuntimeProfile {
  videoEncoder: H264VideoEncoder;
  hardwareAccelerated: boolean;
  softwareThreads: number;
  softwareFilterThreads?: number;
  availableVideoEncoders: H264VideoEncoder[];
  supportsHdrToneMapping: boolean;
}

export interface DetectFfmpegRuntimeOptions {
  ffmpegPath?: string;
  preferredVideoEncoder?: string;
  softwareThreads?: number;
  platform?: NodeJS.Platform;
  encoderOutput?: string;
  filterOutput?: string;
  /** Used only for the automatic default; an explicit thread override wins. */
  maxConcurrentSoftwareTranscodes?: number;
  /**
   * Whether an encoder can actually run here. Injectable so a test can decide
   * without spawning FFmpeg; the default runs a real one-frame encode.
   */
  canRunEncoder?: (encoder: H264VideoEncoder) => Promise<boolean>;
}

export function parseFfmpegVideoEncoders(output: string): Set<string> {
  const encoders = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*V[A-Z.]{5}\s+([^\s]+)/i);

    if (match?.[1]) {
      encoders.add(match[1].toLowerCase());
    }
  }

  return encoders;
}

export function parseFfmpegFilters(output: string): Set<string> {
  const filters = new Set<string>();

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[.A-Z|]{2,4}\s+([^\s]+)/i);

    if (match?.[1]) {
      filters.add(match[1].toLowerCase());
    }
  }

  return filters;
}

function getAutomaticEncoderOrder(
  platform: NodeJS.Platform,
): H264VideoEncoder[] {
  switch (platform) {
    case "darwin":
      return ["h264_videotoolbox", "h264_nvenc", "libx264"];
    case "win32":
      return ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"];
    default:
      return ["h264_nvenc", "h264_qsv", "libx264"];
  }
}

function isKnownEncoder(value: string): value is H264VideoEncoder {
  return H264_VIDEO_ENCODERS.includes(value as H264VideoEncoder);
}

export function selectH264VideoEncoder(
  availableEncoders: Set<string>,
  preferredVideoEncoder = "auto",
  platform: NodeJS.Platform = process.platform,
): H264VideoEncoder {
  const normalizedPreference = preferredVideoEncoder.trim().toLowerCase();

  if (
    normalizedPreference &&
    normalizedPreference !== "auto" &&
    normalizedPreference !== "hardware"
  ) {
    if (normalizedPreference === "software") {
      return "libx264";
    }

    if (
      isKnownEncoder(normalizedPreference) &&
      availableEncoders.has(normalizedPreference)
    ) {
      return normalizedPreference;
    }

    console.warn(
      `[Seyirlik Playback Backend] Requested FFmpeg encoder "${preferredVideoEncoder}" is unavailable; falling back to automatic selection.`,
    );
  }

  const automaticOrder = getAutomaticEncoderOrder(platform);
  const selected = automaticOrder.find((encoder) =>
    availableEncoders.has(encoder),
  );

  if (
    normalizedPreference === "hardware" &&
    (!selected || selected === "libx264")
  ) {
    console.warn(
      "[Seyirlik Playback Backend] No supported hardware H.264 encoder was detected; using bounded software encoding.",
    );
  }

  return selected ?? "libx264";
}

function readFfmpegOutput(
  ffmpegPath: string,
  args: string[],
  probeName: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args);
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `FFmpeg ${probeName} probe failed with exit code ${code ?? "unknown"}: ${stderr}`,
          ),
        );
        return;
      }

      resolve(`${stdout}\n${stderr}`);
    });
  });
}

/**
 * Drops hardware encoders the build advertises but the machine cannot drive.
 *
 * `-encoders` lists everything FFmpeg was compiled with, not everything that
 * can run here. A stock Windows build offers `h264_nvenc` on a box with no
 * NVIDIA driver at all, and because it is first in the automatic order every
 * live transcode was handed to it and died on `Cannot load nvcuda.dll` before
 * a single frame — on a machine whose Intel iGPU would have encoded it.
 *
 * The offline rendition pipeline already refuses to trust the name and probes
 * with a real encode; this is the same probe, applied to the encoder live
 * playback is about to commit to.
 *
 * Probing stops at the first encoder that works, so the ordinary case costs one
 * fraction-of-a-second encode of a black frame and the rest are never spawned.
 * `libx264` is never probed: it is the fallback, and nothing beyond it in the
 * order would be reached anyway.
 */
async function withoutUndriveableEncoders(
  detected: Set<string>,
  ffmpegPath: string,
  options: DetectFfmpegRuntimeOptions,
): Promise<Set<string>> {
  const preference = (options.preferredVideoEncoder ?? "").trim().toLowerCase();

  /*
   * Nothing to validate when the answer cannot be a hardware encoder, and
   * nothing to validate when the caller is simulating detection: supplying
   * `encoderOutput` is a claim about what FFmpeg reports here, and inventing a
   * live probe underneath it would make that claim unusable.
   */
  const canRun =
    options.canRunEncoder ??
    (preference === "software" || options.encoderOutput !== undefined
      ? undefined
      : async (encoder: H264VideoEncoder) =>
          (await probeEncoder(ffmpegPath, encoder)).ok);
  if (!canRun) return detected;

  const order = [
    ...(isKnownEncoder(preference) ? [preference] : []),
    ...getAutomaticEncoderOrder(options.platform ?? process.platform),
  ];

  const usable = new Set(detected);
  const probed = new Set<string>();

  for (const encoder of order) {
    if (encoder === "libx264") break;
    if (probed.has(encoder) || !usable.has(encoder)) continue;
    probed.add(encoder);
    if (await canRun(encoder)) break;
    usable.delete(encoder);
    console.warn(
      `[Seyirlik Playback Backend] FFmpeg lists ${encoder} but it cannot run on this machine; it will not be used.`,
    );
  }

  return usable;
}

export async function detectFfmpegRuntime(
  options: DetectFfmpegRuntimeOptions = {},
): Promise<FfmpegRuntimeProfile> {
  const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
  let encoderOutput = options.encoderOutput;
  let filterOutput = options.filterOutput;

  if (encoderOutput === undefined) {
    [encoderOutput, filterOutput] = await Promise.all([
      readFfmpegOutput(
        ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-encoders"],
        "encoder",
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback Backend] FFmpeg encoder detection failed; the software encoder will be attempted.",
          error instanceof Error ? error.message : String(error),
        );
        return "";
      }),
      readFfmpegOutput(
        ffmpegPath,
        ["-hide_banner", "-loglevel", "error", "-filters"],
        "filter",
      ).catch((error) => {
        console.warn(
          "[Seyirlik Playback Backend] FFmpeg filter detection failed; HDR tone mapping will be disabled.",
          error instanceof Error ? error.message : String(error),
        );
        return "";
      }),
    ]);
  } else {
    filterOutput ??= "";
  }

  const detected = parseFfmpegVideoEncoders(encoderOutput);
  const detectedFilters = parseFfmpegFilters(filterOutput ?? "");

  // libx264 is the controlled fallback even when an unusual FFmpeg build does
  // not list encoders successfully; startup failure remains visible to callers.
  detected.add("libx264");

  const usable = await withoutUndriveableEncoders(
    detected,
    ffmpegPath,
    options,
  );

  const videoEncoder = selectH264VideoEncoder(
    usable,
    options.preferredVideoEncoder,
    options.platform,
  );
  const availableVideoEncoders = H264_VIDEO_ENCODERS.filter((encoder) =>
    usable.has(encoder),
  );

  const softwareThreads =
    options.softwareThreads && options.softwareThreads > 0
      ? Math.floor(options.softwareThreads)
      : defaultSoftwareEncoderThreads({
          concurrentEncodes: options.maxConcurrentSoftwareTranscodes,
        });

  return {
    videoEncoder,
    hardwareAccelerated: videoEncoder !== "libx264",
    softwareThreads,
    softwareFilterThreads: defaultSoftwareFilterThreads(softwareThreads),
    availableVideoEncoders,
    supportsHdrToneMapping:
      detectedFilters.has("zscale") && detectedFilters.has("tonemap"),
  };
}

export function createSoftwareRuntimeProfile(
  softwareThreads: number,
  supportsHdrToneMapping = false,
): FfmpegRuntimeProfile {
  return {
    videoEncoder: "libx264",
    hardwareAccelerated: false,
    softwareThreads: Math.max(1, Math.floor(softwareThreads)),
    softwareFilterThreads: defaultSoftwareFilterThreads(softwareThreads),
    availableVideoEncoders: ["libx264"],
    supportsHdrToneMapping,
  };
}
