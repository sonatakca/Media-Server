import { statfs } from "node:fs/promises";
import { estimateAdaptivePackageBytes } from "../adaptive/packager";
import { codecFamilyForEncoder, type RenditionVideoEncoder } from "../encoding";
import { buildRenditionRequirements, classifyQualityHeight } from "../policy";
import type { RenditionMediaProbe } from "../probe";
import type { HardwareReport } from "../hardware/detect";
import {
  applyStreamPolicy,
  type StreamPolicyOptions,
  type StreamPolicyResult,
} from "./streamPolicy";

/**
 * What processing a source would do, worked out without doing any of it.
 *
 * The same function answers "preview this" and "what is this job going to do",
 * so the plan an operator approves in the UI is the plan the worker executes
 * rather than a description of it written separately.
 */

export type ProcessingAction =
  | "package-adaptive"
  | "skip-already-current"
  | "reject-no-video"
  /**
   * No longer produced: the ladder now reaches the source's own class, so
   * every source with a usable frame has at least one rung, and a frame with
   * no usable dimensions is already rejected as `reject-no-video`. Kept in the
   * vocabulary because jobs recorded before that change still carry it.
   */
  | "reject-too-small"
  | "reject-unsafe-tonemap";

export interface LadderRung {
  qualityHeight: number;
  width: number;
  height: number;
}

export interface DiskEstimate {
  /** Bytes the finished package is expected to occupy. */
  outputBytes: number;
  /** Peak bytes needed in staging while it is produced. */
  stagingBytes: number;
  freeBytes?: number;
  /** False when the volume cannot hold staging plus output plus a reserve. */
  sufficient: boolean;
  reserveBytes: number;
}

export interface ProcessingDecision {
  action: ProcessingAction;
  /** One sentence explaining the action, for the UI and the job record. */
  summary: string;
  source: {
    container: string;
    durationSeconds: number;
    sizeBytes: number;
    width: number;
    height: number;
    qualityHeight: number;
    frameRate?: number;
    videoCodec: string;
    videoProfile?: string;
    bitDepth?: number;
    pixelFormat?: string;
    isHdr: boolean;
    colorTransfer?: string;
    colorPrimaries?: string;
  };
  ladder: LadderRung[];
  videoCodec: "h264" | "hevc";
  videoEncoder: RenditionVideoEncoder;
  hardwareAdapter: string;
  /** True when HDR is carried through rather than tone mapped. */
  preservesHdr: boolean;
  streams: StreamPolicyResult;
  estimate: DiskEstimate;
  warnings: string[];
}

export interface DecideProcessingInput {
  probe: RenditionMediaProbe;
  container: string;
  sizeBytes: number;
  hardware: HardwareReport;
  policy?: StreamPolicyOptions;
  /** Free bytes on the output volume, when known. */
  freeBytes?: number;
  /** Bytes to leave unused on the output volume. */
  reserveBytes?: number;
  /** True when a current package for this exact source already exists. */
  alreadyCurrent?: boolean;
}

/** Headroom kept free on the output volume so a full disk cannot be reached. */
export const DEFAULT_RESERVE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Staging holds the package being built before it is published.
 *
 * Sized at the full output plus a quarter: segments are written once and the
 * validator reads them in place, so the peak is the package itself with room
 * for the playlists and metadata written alongside it.
 */
function stagingBytesFor(outputBytes: number): number {
  return Math.ceil(outputBytes * 1.25);
}

export async function freeBytesOn(
  directory: string,
): Promise<number | undefined> {
  try {
    const stats = await statfs(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

export function decideProcessing(
  input: DecideProcessingInput,
): ProcessingDecision {
  const { probe, hardware } = input;
  const warnings: string[] = [];
  const streams = applyStreamPolicy(probe, input.policy);
  warnings.push(...streams.warnings);

  const sourceQualityHeight = classifyQualityHeight({
    width: probe.video.width,
    height: probe.video.height,
    rotation: probe.video.rotation,
  });
  const ladder = buildRenditionRequirements({
    width: probe.video.width,
    height: probe.video.height,
    rotation: probe.video.rotation,
  }).map((requirement) => ({
    qualityHeight: requirement.qualityHeight,
    width: requirement.width,
    height: requirement.height,
  }));

  // HDR is carried in HEVC Main 10, which is the only lane a browser decodes
  // 10-bit in. An SDR source uses H.264, which every target plays.
  const preservesHdr = probe.video.isHdr;
  const videoCodec: "h264" | "hevc" = preservesHdr ? "hevc" : "h264";
  const encoder = preservesHdr
    ? probe.video.bitDepth && probe.video.bitDepth > 8
      ? hardware.selected.hevcTenBit
      : hardware.selected.hevc
    : hardware.selected.h264;
  const hardwareAdapter = preservesHdr
    ? probe.video.bitDepth && probe.video.bitDepth > 8
      ? hardware.selectedAdapter.hevcTenBit
      : hardware.selectedAdapter.hevc
    : hardware.selectedAdapter.h264;

  const estimateBytes = estimateAdaptivePackageBytes({
    durationSeconds: probe.durationSeconds,
    qualityHeights: ladder.map((rung) => rung.qualityHeight),
    codecFamily: codecFamilyForEncoder(encoder),
    audioTrackCount: Math.max(1, streams.keptAudioStreamIndexes.length),
  });
  const reserveBytes = input.reserveBytes ?? DEFAULT_RESERVE_BYTES;
  const stagingBytes = stagingBytesFor(estimateBytes.totalBytes);
  const required = estimateBytes.totalBytes + stagingBytes + reserveBytes;
  const estimate: DiskEstimate = {
    outputBytes: estimateBytes.totalBytes,
    stagingBytes,
    ...(input.freeBytes === undefined ? {} : { freeBytes: input.freeBytes }),
    sufficient:
      input.freeBytes === undefined ? true : input.freeBytes >= required,
    reserveBytes,
  };
  if (!estimate.sufficient) {
    warnings.push(
      "The output volume does not have room for this package plus its staging copy.",
    );
  }

  const source: ProcessingDecision["source"] = {
    container: input.container,
    durationSeconds: probe.durationSeconds,
    sizeBytes: input.sizeBytes,
    width: probe.video.width,
    height: probe.video.height,
    qualityHeight: sourceQualityHeight,
    ...(probe.video.frameRate === undefined
      ? {}
      : { frameRate: probe.video.frameRate }),
    videoCodec: probe.video.codec,
    ...(probe.video.bitDepth === undefined
      ? {}
      : { bitDepth: probe.video.bitDepth }),
    ...(probe.video.pixelFormat
      ? { pixelFormat: probe.video.pixelFormat }
      : {}),
    isHdr: probe.video.isHdr,
    ...(probe.video.colorTransfer
      ? { colorTransfer: probe.video.colorTransfer }
      : {}),
    ...(probe.video.colorPrimaries
      ? { colorPrimaries: probe.video.colorPrimaries }
      : {}),
  };

  const base = {
    source,
    ladder,
    videoCodec,
    videoEncoder: encoder,
    hardwareAdapter,
    preservesHdr,
    streams,
    estimate,
    warnings,
  };

  if (probe.video.width <= 0 || probe.video.height <= 0) {
    return {
      ...base,
      action: "reject-no-video",
      summary: "This file has no usable video stream.",
    };
  }
  if (input.alreadyCurrent) {
    return {
      ...base,
      action: "skip-already-current",
      summary: "A current package for this exact source already exists.",
    };
  }

  const rungs = ladder.map((rung) => `${rung.qualityHeight}p`).join(", ");
  const audioCount = streams.keptAudioStreamIndexes.length;
  const subtitleCount = streams.keptSubtitleStreamIndexes.length;
  return {
    ...base,
    action: "package-adaptive",
    summary:
      `Package ${rungs} ${videoCodec === "hevc" ? "HEVC" : "H.264"}` +
      `${preservesHdr ? " HDR" : ""} with ${audioCount} audio ` +
      `${audioCount === 1 ? "rendition" : "renditions"}` +
      `${subtitleCount > 0 ? ` and ${subtitleCount} subtitle ${subtitleCount === 1 ? "track" : "tracks"}` : ""}.`,
  };
}
