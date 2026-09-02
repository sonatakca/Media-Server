/**
 * Level-one validation: proving one epoch is worth keeping forever.
 *
 * A checkpoint is promoted to immutable, and every later run reuses it without
 * re-examining the encoder that made it, so this is the only moment at which a
 * bad epoch can be caught cheaply. It is therefore deliberately strict: every
 * claim is measured from the packaged bytes, and an epoch that cannot prove its
 * own timeline is discarded and encoded again rather than joined to the ones
 * around it.
 *
 * The property that matters most is the one a whole-title encode used to get
 * for free — that every rung describes the same instants. Within an epoch it
 * still comes from a single decode feeding every branch, but "still" is not
 * "provably", so it is measured segment by segment here.
 */

import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseMediaPlaylist } from "../playlist";
import { probePackagedVideo } from "../probePackaged";
import { ALIGNMENT_EPSILON_SECONDS } from "../profile";
import { readFragmentTiming, readInitSegment } from "./fragments";

export interface EpochRenditionExpectation {
  id: string;
  qualityHeight: number;
  width: number;
  height: number;
  /** `h264` or `hevc`. */
  codecFamily: "h264" | "hevc";
  hdr: string;
  /** Directory inside the epoch, e.g. `video/1080p`. */
  directory: string;
  mediaFile: string;
  playlistFile: string;
}

export interface EpochMeasurement {
  id: string;
  mediaTimescale: number;
  initDigest: string;
  /** Decode time of the first fragment, in the rendition's media timescale. */
  firstDecodeTicks: number;
  /** Sum of every fragment's sample durations. */
  totalTicks: number;
  measuredDurationSeconds: number;
  segmentCount: number;
  fileSizeBytes: number;
  /** Segment start times relative to the epoch, in seconds. */
  segmentStartSeconds: number[];
  probe: Awaited<ReturnType<typeof probePackagedVideo>>;
}

export interface EpochValidationIssue {
  rendition: string;
  stage: string;
  message: string;
}

export interface EpochValidationResult {
  ok: boolean;
  issues: EpochValidationIssue[];
  checks: string[];
  measurements: EpochMeasurement[];
}

/** Longest an epoch may differ from the media time the plan gave it. */
export const EPOCH_DURATION_TOLERANCE_SECONDS = 0.25;

async function readRange(
  filePath: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) {
      throw new Error(
        `Expected ${length} bytes at ${offset} but the file held ${bytesRead}.`,
      );
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Measures one rendition inside an epoch directory.
 *
 * Reads the fragments' own boxes rather than trusting the playlist's `EXTINF`
 * figures: the playlist is what the muxer *said*, and the boxes are what a
 * player will actually decode. Where the two disagree the boxes win, and the
 * disagreement is a validation failure.
 */
export async function measureEpochRendition({
  epochDirectory,
  expectation,
  ffprobePath,
  signal,
}: {
  epochDirectory: string;
  expectation: EpochRenditionExpectation;
  ffprobePath: string;
  signal?: AbortSignal;
}): Promise<EpochMeasurement> {
  const mediaPath = path.join(
    epochDirectory,
    ...expectation.directory.split("/"),
    expectation.mediaFile,
  );
  const playlistPath = path.join(
    epochDirectory,
    ...expectation.directory.split("/"),
    expectation.playlistFile,
  );

  const playlist = parseMediaPlaylist(await readFile(playlistPath, "utf8"));
  const stats = await stat(mediaPath);

  const init = await readRange(
    mediaPath,
    playlist.map.byteRange.offset,
    playlist.map.byteRange.length,
  );
  const { mediaTimescale, handler } = readInitSegment(init);
  if (handler !== "vide") {
    throw new Error(
      `Rendition ${expectation.id} does not carry a video track handler.`,
    );
  }

  let firstDecodeTicks: number | undefined;
  let totalTicks = 0;
  const segmentStartSeconds: number[] = [];
  let previousDecode = -1;

  for (const segment of playlist.segments) {
    const bytes = await readRange(
      mediaPath,
      segment.byteRange.offset,
      segment.byteRange.length,
    );
    const timing = readFragmentTiming(bytes);
    if (!timing) {
      throw new Error(
        `Rendition ${expectation.id} has a segment with no decode time.`,
      );
    }
    if (timing.baseMediaDecodeTime <= previousDecode) {
      throw new Error(
        `Rendition ${expectation.id} has a segment whose decode time goes backwards.`,
      );
    }
    previousDecode = timing.baseMediaDecodeTime;
    firstDecodeTicks ??= timing.baseMediaDecodeTime;
    totalTicks += timing.sampleDurationTicks;
    segmentStartSeconds.push(timing.baseMediaDecodeTime / mediaTimescale);
  }

  if (firstDecodeTicks === undefined) {
    throw new Error(`Rendition ${expectation.id} has no segments.`);
  }

  const probe = await probePackagedVideo(mediaPath, ffprobePath, signal);

  return {
    id: expectation.id,
    mediaTimescale,
    initDigest: createHash("sha256").update(init).digest("hex"),
    firstDecodeTicks,
    totalTicks,
    measuredDurationSeconds: totalTicks / mediaTimescale,
    segmentCount: playlist.segments.length,
    fileSizeBytes: stats.size,
    segmentStartSeconds,
    probe,
  };
}

export interface ValidateEpochInput {
  epochDirectory: string;
  expectations: readonly EpochRenditionExpectation[];
  expectedDurationSeconds: number;
  /** How far the ladder's rungs may disagree about one instant. */
  alignmentToleranceSeconds: number;
  ffprobePath: string;
  signal?: AbortSignal;
}

export async function validateEpoch({
  epochDirectory,
  expectations,
  expectedDurationSeconds,
  alignmentToleranceSeconds,
  ffprobePath,
  signal,
}: ValidateEpochInput): Promise<EpochValidationResult> {
  const issues: EpochValidationIssue[] = [];
  const checks: string[] = [];
  const measurements: EpochMeasurement[] = [];

  for (const expectation of expectations) {
    try {
      const measurement = await measureEpochRendition({
        epochDirectory,
        expectation,
        ffprobePath,
        ...(signal ? { signal } : {}),
      });
      measurements.push(measurement);

      if (measurement.fileSizeBytes === 0) {
        issues.push({
          rendition: expectation.id,
          stage: "media",
          message: "The rendition media file is empty.",
        });
      }
      if (
        measurement.probe.width !== expectation.width ||
        measurement.probe.height !== expectation.height
      ) {
        issues.push({
          rendition: expectation.id,
          stage: "dimensions",
          message: `Encoded ${measurement.probe.width}x${measurement.probe.height}, expected ${expectation.width}x${expectation.height}.`,
        });
      }
      const codec = measurement.probe.codec.toLowerCase();
      if (codec !== expectation.codecFamily) {
        issues.push({
          rendition: expectation.id,
          stage: "codec",
          message: `Encoded as ${codec}, expected ${expectation.codecFamily}.`,
        });
      }
      /*
       * An HDR rendition that lost its transfer function is the failure this
       * check exists for: it plays, it looks washed out, and nothing else in
       * the pipeline notices. Ten-bit pixels are the observable consequence.
       */
      if (expectation.hdr !== "sdr") {
        const tenBit = measurement.probe.pixelFormat.includes("10");
        if (!tenBit) {
          issues.push({
            rendition: expectation.id,
            stage: "hdr",
            message: `HDR rendition was written as ${measurement.probe.pixelFormat}, which is not ten-bit.`,
          });
        }
        if (
          measurement.probe.colorTransfer === undefined ||
          measurement.probe.colorPrimaries === undefined
        ) {
          issues.push({
            rendition: expectation.id,
            stage: "hdr",
            message:
              "HDR rendition carries no colour transfer or primaries, so a player must guess at its grade.",
          });
        }
      }

      const drift = Math.abs(
        measurement.measuredDurationSeconds - expectedDurationSeconds,
      );
      if (drift > EPOCH_DURATION_TOLERANCE_SECONDS) {
        issues.push({
          rendition: expectation.id,
          stage: "duration",
          message: `Covers ${measurement.measuredDurationSeconds.toFixed(3)}s of media where the plan expected ${expectedDurationSeconds.toFixed(3)}s.`,
        });
      }
    } catch (error) {
      issues.push({
        rendition: expectation.id,
        stage: "measure",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  checks.push(`measured ${measurements.length} rendition(s)`);

  /*
   * The switching property. Every rung has to cut on the same instants, or a
   * player moving between them mid-epoch lands somewhere the other rung has no
   * random-access point — which is a freeze with nothing in any log.
   */
  const reference = measurements[0];
  if (reference) {
    for (const measurement of measurements.slice(1)) {
      if (measurement.segmentCount !== reference.segmentCount) {
        issues.push({
          rendition: measurement.id,
          stage: "alignment",
          message: `Has ${measurement.segmentCount} segments where ${reference.id} has ${reference.segmentCount}.`,
        });
        continue;
      }
      for (let index = 0; index < measurement.segmentCount; index += 1) {
        const delta = Math.abs(
          measurement.segmentStartSeconds[index]! -
            reference.segmentStartSeconds[index]!,
        );
        if (delta > alignmentToleranceSeconds) {
          issues.push({
            rendition: measurement.id,
            stage: "alignment",
            message: `Segment ${index} starts ${delta.toFixed(4)}s away from ${reference.id}, beyond the ${alignmentToleranceSeconds.toFixed(4)}s tolerance.`,
          });
          break;
        }
      }
      const durationDelta = Math.abs(
        measurement.measuredDurationSeconds - reference.measuredDurationSeconds,
      );
      if (
        durationDelta >
        alignmentToleranceSeconds + ALIGNMENT_EPSILON_SECONDS
      ) {
        issues.push({
          rendition: measurement.id,
          stage: "alignment",
          message: `Ends ${durationDelta.toFixed(4)}s away from ${reference.id}.`,
        });
      }
    }
    checks.push("every rung cuts on the same instants");
  }

  /*
   * Epochs are joined by concatenating fragments under one initialisation
   * segment, so a rung whose initialisation differs between epochs cannot be
   * joined at all. The digest is recorded here and compared across epochs by
   * the assembler, which is the only place that can see more than one.
   */
  checks.push("initialisation digest recorded for cross-epoch comparison");

  return { ok: issues.length === 0, issues, checks, measurements };
}
