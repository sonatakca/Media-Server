/**
 * The resumable encoder.
 *
 * One loop, one rule: for every epoch in the plan, either a valid checkpoint
 * already exists and is reused, or one FFmpeg process reads the source once,
 * decodes it once, and produces every rung of the ladder for that five minutes.
 * Nothing else in the system decides what to encode — the CLI and the server
 * job both come through here, so "why did it re-encode that" has one answer.
 *
 * The loop is written so that every exit is safe. An abort, a pause that turns
 * into a stop, a vanished volume and a failed validation all leave the
 * completed epochs untouched and at most the running one to redo.
 */

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PauseController } from "../../processing/pauseController";
import type { RenditionHdrSignal, RenditionVideoEncoder } from "../../encoding";
import { parseFfmpegProgressFields } from "../../progress";
import { createOutputMeter } from "../../outputMeter";
import {
  adaptiveOutputDirectories,
  buildAdaptivePackageFfmpegArgs,
  type AdaptiveVideoOutput,
} from "../encoding";
import {
  ADAPTIVE_MASTER_PLAYLIST,
  ADAPTIVE_MEDIA_FILE,
  ADAPTIVE_PLAYLIST_FILE,
  ADAPTIVE_VIDEO_DIRECTORY,
  videoRenditionId,
} from "../profile";
import {
  beginPartialEpoch,
  completedEpochPath,
  readEpochManifest,
  reconcileCheckpoints,
  type CheckpointIdentity,
  type EpochCheckpointManifest,
  type EpochRenditionRecord,
  type ReconciliationOutcome,
} from "./checkpoints";
import {
  EPOCH_CHECKPOINT_SCHEMA_VERSION,
  SOURCE_IO_RETRY_BACKOFF_MS,
} from "./policy";
import { protectedSecondsAfter, type EpochPlan } from "./plan";
import { timestampSeconds } from "./sourceTimeline";
import { validateEpoch, type EpochRenditionExpectation } from "./validateEpoch";
import {
  classifyFailure,
  looksLikeOutOfSpace,
  looksLikeStorageLoss,
  SourceReadError,
  StorageInterruptedError,
} from "./failure";

/** FFmpeg reports four times a second, which is what makes the page feel live. */
export const EPOCH_STATS_PERIOD_SECONDS = 0.25;

export type EpochBuildEvent =
  | {
      type: "reconciled";
      outcome: ReconciliationOutcome;
      epochCount: number;
      protectedSeconds: number;
    }
  | {
      type: "epoch-reused";
      index: number;
      epochCount: number;
      protectedSeconds: number;
    }
  | {
      type: "epoch-start";
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      attempt: number;
    }
  | {
      type: "epoch-progress";
      index: number;
      epochCount: number;
      startSeconds: number;
      endSeconds: number;
      /** FFmpeg's own out_time for this epoch. */
      epochProcessedSeconds: number;
      protectedSeconds: number;
      sourceDurationSeconds: number;
      fps?: number;
      speed?: number;
      writtenBytes?: number;
    }
  | {
      type: "epoch-complete";
      index: number;
      epochCount: number;
      protectedSeconds: number;
      bytes: number;
      elapsedMs: number;
    }
  | {
      type: "epoch-invalid";
      index: number;
      reason: string;
    }
  | {
      /**
       * The source failed to read and the volume was still there afterwards.
       *
       * Emitted before each re-read so the operator sees the escalation happen
       * rather than a job that silently sits still for twenty seconds.
       */
      type: "source-io-retry";
      index: number;
      attempt: number;
      maxAttempts: number;
      /** Whether the source window could be read back between attempts. */
      sourceReadable?: boolean;
      detail: string;
    };

export interface EpochEncodeRunner {
  (
    command: string,
    args: string[],
    options: {
      signal?: AbortSignal;
      logPath: string;
      onProgress?: (
        progress: ReturnType<typeof parseFfmpegProgressFields>,
      ) => void;
      pauseController?: PauseController;
    },
  ): Promise<void>;
}

export interface RunEpochBuildInput {
  identity: CheckpointIdentity;
  checkpointRoot: string;
  plan: EpochPlan;
  sourcePath: string;
  videoOutputs: readonly AdaptiveVideoOutput[];
  encoder: RenditionVideoEncoder;
  codecFamily: "h264" | "hevc";
  hdr?: RenditionHdrSignal;
  hdrState: string;
  /** Ceiling frame rate the GOP is sized from. */
  frameRate?: number;
  segmentSeconds: number;
  preset: string;
  softwareThreads?: number;
  filterComplexThreads?: number;
  ffmpegPath: string;
  ffprobePath: string;
  logPath: string;
  runEncoder: EpochEncodeRunner;
  signal?: AbortSignal;
  pauseController?: PauseController;
  /** Answers "is the storage this job needs there right now?" on failure. */
  storageAvailable?: () => boolean | Promise<boolean>;
  missingRoots?: () => readonly string[];
  onEvent?: (event: EpochBuildEvent) => void;
  /** Attempts allowed per epoch before the build gives up. */
  attemptsPerEpoch?: number;
  /**
   * Waits between re-reading a source that returned an I/O error.
   *
   * Each one has to outlast a watchdog poll, because the whole point of the
   * wait is to give a genuinely vanished volume time to be noticed as vanished.
   * Overridable so tests do not have to spend the real half minute.
   */
  sourceIoBackoffMs?: readonly number[];
  /**
   * A bounded readability check of one epoch's source window.
   *
   * Called between I/O retries. Its answer is recorded rather than acted on:
   * a probe that reads the window does not promise the encoder will, and one
   * that fails is the same evidence a second time. What it buys is a plain
   * statement in the job record of whether the source itself could be read
   * while the volume was demonstrably healthy.
   */
  verifySourceReadable?: (epochIndex: number) => Promise<boolean>;
  /** Injected by failure-injection tests to stop between epochs. */
  beforeEpoch?: (index: number) => void | Promise<void>;
}

export interface EpochBuildResult {
  manifests: EpochCheckpointManifest[];
  reconciliation: ReconciliationOutcome;
  /** Epochs this run actually encoded, as against reused. */
  encodedEpochs: number[];
  /** Bytes this run wrote into checkpoints. */
  bytesWritten: number;
  /** Codec strings FFmpeg derived from the real bitstream, by rendition id. */
  videoCodecStrings: Map<string, string>;
}

function expectationsFor(
  videoOutputs: readonly AdaptiveVideoOutput[],
  codecFamily: "h264" | "hevc",
  hdrState: string,
): EpochRenditionExpectation[] {
  return videoOutputs.map((output) => {
    const id = videoRenditionId(output.qualityHeight);
    return {
      id,
      qualityHeight: output.qualityHeight,
      width: output.width,
      height: output.height,
      codecFamily,
      hdr: hdrState,
      directory: `${ADAPTIVE_VIDEO_DIRECTORY}/${id}`,
      mediaFile: ADAPTIVE_MEDIA_FILE,
      playlistFile: ADAPTIVE_PLAYLIST_FILE,
    };
  });
}

/**
 * Codec strings, read from the master FFmpeg wrote beside the epoch.
 *
 * They are derived from the real bitstream and are the one part of a master
 * playlist that cannot be guessed safely, so they are harvested rather than
 * constructed. Every epoch produces the same ones because every epoch is
 * encoded with the same settings — which the identical initialisation segments
 * independently prove — so the first available epoch answers for all of them.
 */
async function harvestCodecStrings(
  epochDirectory: string,
  renditionIds: readonly string[],
): Promise<Map<string, string>> {
  const { parseCodecsFromGeneratedMaster } = await import("../playlist");
  const text = await readFile(
    path.join(epochDirectory, ADAPTIVE_MASTER_PLAYLIST),
    "utf8",
  ).catch(() => null);
  const found = new Map<string, string>();
  if (text === null) return found;
  const byPath = parseCodecsFromGeneratedMaster(text);
  for (const id of renditionIds) {
    const codecs = byPath.get(
      `${ADAPTIVE_VIDEO_DIRECTORY}/${id}/${ADAPTIVE_PLAYLIST_FILE}`,
    );
    const video = codecs?.split(",")[0]?.trim();
    if (video) found.set(id, video);
  }
  return found;
}

export async function runEpochBuild({
  identity,
  checkpointRoot,
  plan,
  sourcePath,
  videoOutputs,
  encoder,
  codecFamily,
  hdr,
  hdrState,
  frameRate,
  segmentSeconds,
  preset,
  softwareThreads,
  filterComplexThreads,
  ffmpegPath,
  ffprobePath,
  logPath,
  runEncoder,
  signal,
  pauseController,
  storageAvailable,
  missingRoots,
  onEvent,
  attemptsPerEpoch = 2,
  sourceIoBackoffMs = SOURCE_IO_RETRY_BACKOFF_MS,
  verifySourceReadable,
  beforeEpoch,
}: RunEpochBuildInput): Promise<EpochBuildResult> {
  const expectations = expectationsFor(videoOutputs, codecFamily, hdrState);
  const renditionIds = expectations.map((entry) => entry.id);

  const reconciliation = await reconcileCheckpoints({
    root: checkpointRoot,
    plan,
    identity,
    requiredRenditionIds: renditionIds,
  });
  for (const entry of reconciliation.invalidated) {
    onEvent?.({
      type: "epoch-invalid",
      index: entry.index,
      reason: entry.reason,
    });
  }
  onEvent?.({
    type: "reconciled",
    outcome: reconciliation,
    epochCount: plan.epochs.length,
    protectedSeconds: contiguousProtectedSeconds(plan, reconciliation.complete),
  });

  const completed = new Set(reconciliation.complete);
  const manifests: EpochCheckpointManifest[] = [];
  const encodedEpochs: number[] = [];
  let bytesWritten = 0;
  let videoCodecStrings = new Map<string, string>();

  /**
   * One frame of the source, which is the closest two rungs can ever land.
   *
   * Demanding better would fail every real encode; allowing more would let a
   * genuinely misaligned ladder through.
   */
  const alignmentToleranceSeconds =
    (frameRate && frameRate > 0 ? 1 / frameRate : 1 / 30) + 0.002;

  for (const epoch of plan.epochs) {
    if (signal?.aborted) throw abortError();

    if (completed.has(epoch.index)) {
      const manifest = await readEpochManifest(checkpointRoot, epoch.index);
      if (manifest) {
        manifests.push(manifest);
        if (videoCodecStrings.size === 0) {
          videoCodecStrings = await harvestCodecStrings(
            completedEpochPath(checkpointRoot, epoch.index),
            renditionIds,
          );
        }
        onEvent?.({
          type: "epoch-reused",
          index: epoch.index,
          epochCount: plan.epochs.length,
          protectedSeconds: protectedSecondsAfter(plan, manifests.length),
        });
        continue;
      }
      // The manifest vanished between reconciliation and now. Encode it.
      completed.delete(epoch.index);
    }

    await beforeEpoch?.(epoch.index);
    if (signal?.aborted) throw abortError();

    const startSeconds = timestampSeconds(epoch.start);
    const endSeconds = epoch.end
      ? timestampSeconds(epoch.end)
      : plan.sourceDurationSeconds;

    let lastValidationError: string | undefined;
    let promoted: EpochCheckpointManifest | undefined;
    /*
     * Reads of this epoch that ended in an I/O error while the volume kept
     * answering. Counted per epoch and given its own budget, so a bad region of
     * the source cannot be spent by a validation retry and a failing encoder
     * cannot spend the read budget.
     */
    let sourceIoAttempts = 0;
    const sourceIoMaxAttempts = sourceIoBackoffMs.length + 1;

    for (
      let attempt = 1;
      attempt <= attemptsPerEpoch + sourceIoAttempts;
      attempt += 1
    ) {
      if (signal?.aborted) throw abortError();
      const startedAt = Date.now();
      onEvent?.({
        type: "epoch-start",
        index: epoch.index,
        epochCount: plan.epochs.length,
        startSeconds,
        endSeconds,
        attempt,
      });

      const handle = await beginPartialEpoch({
        root: checkpointRoot,
        index: epoch.index,
      });

      try {
        for (const directory of adaptiveOutputDirectories({
          videoOutputs: [...videoOutputs],
          audioOutputs: [],
        })) {
          await mkdir(path.join(handle.directory, ...directory.split("/")), {
            recursive: true,
          });
        }

        const args = buildAdaptivePackageFfmpegArgs({
          inputPath: sourcePath,
          // FFmpeg joins `%v` templates with forward slashes on every platform.
          outputRoot: handle.directory.split(path.sep).join("/"),
          videoOutputs: [...videoOutputs],
          audioOutputs: [],
          encoder,
          ...(hdr ? { hdr } : {}),
          ...(frameRate === undefined ? {} : { frameRate }),
          segmentSeconds,
          preset,
          ...(softwareThreads === undefined ? {} : { softwareThreads }),
          ...(filterComplexThreads === undefined
            ? {}
            : { filterComplexThreads }),
          ...(epoch.seekSeconds > 0 ? { startSeconds: epoch.seekSeconds } : {}),
          ...(epoch.durationSeconds === undefined
            ? {}
            : { durationSeconds: epoch.durationSeconds }),
          statsPeriodSeconds: EPOCH_STATS_PERIOD_SECONDS,
        });

        const protectedSeconds = protectedSecondsAfter(plan, epoch.index);
        /*
         * FFmpeg reports `total_size=N/A` for HLS, so the only honest byte
         * figure is the one measured from the files being written. Sampled from
         * the partial epoch rather than the finished package, because that is
         * where this run's bytes are actually landing.
         */
        const meter = createOutputMeter(
          videoOutputs.map((output) =>
            path.join(
              handle.directory,
              ADAPTIVE_VIDEO_DIRECTORY,
              videoRenditionId(output.qualityHeight),
              ADAPTIVE_MEDIA_FILE,
            ),
          ),
        );
        try {
          await runEncoder(ffmpegPath, args, {
            ...(signal ? { signal } : {}),
            ...(pauseController ? { pauseController } : {}),
            logPath,
            ...(onEvent
              ? {
                  onProgress: (progress) => {
                    meter.sample();
                    const epochBytes = meter.latest();
                    onEvent({
                      type: "epoch-progress",
                      index: epoch.index,
                      epochCount: plan.epochs.length,
                      startSeconds,
                      endSeconds,
                      epochProcessedSeconds: progress.processedSeconds,
                      protectedSeconds,
                      sourceDurationSeconds: plan.sourceDurationSeconds,
                      ...(progress.fps === undefined
                        ? {}
                        : { fps: progress.fps }),
                      ...(progress.speed === undefined
                        ? {}
                        : { speed: progress.speed }),
                      ...(epochBytes === undefined
                        ? {}
                        : { writtenBytes: epochBytes }),
                    });
                  },
                }
              : {}),
          });
        } catch (error) {
          if (signal?.aborted) throw abortError();
          const message =
            error instanceof Error ? error.message : String(error);

          /*
           * The volume is asked first, and asked directly rather than inferred
           * from the message. If it is gone the answer is settled.
           */
          let available = storageAvailable ? await storageAvailable() : true;

          /*
           * An I/O error while the volume still answers is the ambiguous case,
           * and it is ambiguous only because the watchdog polls: the drive may
           * already be gone and the check simply has not run yet. So the
           * storage is asked again after a wait long enough to outlast a poll,
           * and the error is counted against the *source* only once the volume
           * has proved, repeatedly, that it is still there and still itself.
           */
          let ioRechecksExhausted = false;
          if (
            available &&
            looksLikeStorageLoss(message) &&
            !looksLikeOutOfSpace(message)
          ) {
            const backoff = sourceIoBackoffMs[sourceIoAttempts];
            if (backoff !== undefined && backoff > 0) {
              await delay(backoff, signal);
              if (signal?.aborted) throw abortError();
              available = storageAvailable ? await storageAvailable() : true;
            }
            if (available) {
              sourceIoAttempts += 1;
              ioRechecksExhausted = sourceIoAttempts >= sourceIoMaxAttempts;
              const readable = ioRechecksExhausted
                ? undefined
                : await verifySourceReadable?.(epoch.index).catch(() => false);
              onEvent?.({
                type: "source-io-retry",
                index: epoch.index,
                attempt: sourceIoAttempts,
                maxAttempts: sourceIoMaxAttempts,
                ...(readable === undefined ? {} : { sourceReadable: readable }),
                detail: message.slice(-500),
              });
              if (!ioRechecksExhausted) {
                await handle.discard();
                continue;
              }
            }
          }

          const failure = classifyFailure({
            message,
            storageAvailable: available,
            ...(missingRoots ? { missingRoots: missingRoots() } : {}),
            ioRechecksExhausted,
          });
          if (failure.kind === "source-io") {
            /*
             * Terminal on purpose. Every checkpoint stays where it is, so a
             * retry after the media is repaired or replaced re-encodes only
             * the epoch that could not be read.
             */
            throw new SourceReadError(failure, epoch.index, sourceIoAttempts);
          }
          if (
            failure.kind === "storage-unavailable" ||
            failure.kind === "out-of-space"
          ) {
            /*
             * Not a defect in the job. The partial workspace goes, every
             * completed epoch stays, and the caller decides whether to wait for
             * the volume or to report a shortfall.
             */
            throw new StorageInterruptedError(failure);
          }
          throw new Error(`${failure.summary} ${failure.detail}`.trim());
        }

        if (signal?.aborted) throw abortError();

        const validation = await validateEpoch({
          epochDirectory: handle.directory,
          expectations,
          expectedDurationSeconds: epoch.expectedDurationSeconds,
          alignmentToleranceSeconds,
          ffprobePath,
          ...(signal ? { signal } : {}),
        });

        if (!validation.ok) {
          lastValidationError = validation.issues
            .map(
              (issue) => `${issue.rendition}/${issue.stage}: ${issue.message}`,
            )
            .slice(0, 4)
            .join("; ");
          onEvent?.({
            type: "epoch-invalid",
            index: epoch.index,
            reason: lastValidationError,
          });
          await handle.discard();
          continue;
        }

        if (videoCodecStrings.size === 0) {
          videoCodecStrings = await harvestCodecStrings(
            handle.directory,
            renditionIds,
          );
        }

        const renditions: EpochRenditionRecord[] = validation.measurements.map(
          (measurement) => {
            const expectation = expectations.find(
              (entry) => entry.id === measurement.id,
            )!;
            return {
              id: measurement.id,
              qualityHeight: expectation.qualityHeight,
              width: measurement.probe.width,
              height: measurement.probe.height,
              codec: codecFamily,
              ...(videoCodecStrings.get(measurement.id)
                ? { codecString: videoCodecStrings.get(measurement.id)! }
                : {}),
              pixelFormat: measurement.probe.pixelFormat,
              hdr: hdrState,
              ...(measurement.probe.colorPrimaries
                ? { colorPrimaries: measurement.probe.colorPrimaries }
                : {}),
              ...(measurement.probe.colorTransfer
                ? { colorTransfer: measurement.probe.colorTransfer }
                : {}),
              ...(measurement.probe.colorSpace
                ? { colorSpace: measurement.probe.colorSpace }
                : {}),
              frameRate: measurement.probe.frameRate,
              mediaPath: `${expectation.directory}/${expectation.mediaFile}`,
              playlistPath: `${expectation.directory}/${expectation.playlistFile}`,
              fileSizeBytes: measurement.fileSizeBytes,
              segmentCount: measurement.segmentCount,
              measuredDurationSeconds: measurement.measuredDurationSeconds,
              mediaTimescale: measurement.mediaTimescale,
              initDigest: measurement.initDigest,
            };
          },
        );

        const totalBytes = renditions.reduce(
          (sum, entry) => sum + entry.fileSizeBytes,
          0,
        );
        const manifest: EpochCheckpointManifest = {
          schemaVersion: EPOCH_CHECKPOINT_SCHEMA_VERSION,
          mediaId: identity.mediaId,
          sourceFingerprint: identity.sourceFingerprint,
          adaptiveProfileVersion: identity.adaptiveProfileVersion,
          timelinePolicyVersion: identity.timelinePolicyVersion,
          epochIndex: epoch.index,
          startSeconds,
          endSeconds: epoch.end ? timestampSeconds(epoch.end) : null,
          expectedDurationSeconds: epoch.expectedDurationSeconds,
          actualDurationSeconds: Math.max(
            ...validation.measurements.map(
              (measurement) => measurement.measuredDurationSeconds,
            ),
          ),
          encoder,
          renditions,
          totalBytes,
          checks: validation.checks,
          completedAt: new Date().toISOString(),
        };

        await handle.promote(manifest);
        promoted = manifest;
        bytesWritten += totalBytes;
        encodedEpochs.push(epoch.index);
        manifests.push(manifest);
        onEvent?.({
          type: "epoch-complete",
          index: epoch.index,
          epochCount: plan.epochs.length,
          protectedSeconds: protectedSecondsAfter(plan, manifests.length),
          bytes: totalBytes,
          elapsedMs: Date.now() - startedAt,
        });
        break;
      } catch (error) {
        await handle.discard();
        throw error;
      } finally {
        handle.release();
      }
    }

    if (!promoted) {
      throw new Error(
        `Epoch ${epoch.index} (${formatClock(startSeconds)}–${formatClock(endSeconds)}) failed validation and was not kept: ${lastValidationError ?? "no reason recorded"}`,
      );
    }
  }

  return {
    manifests,
    reconciliation,
    encodedEpochs,
    bytesWritten,
    videoCodecStrings,
  };
}

/**
 * Protected media time given a set of completed epochs.
 *
 * Only a *contiguous* run from the beginning counts. Epoch 7 being complete
 * while epoch 3 is missing protects nothing: the title cannot be assembled up
 * to seven, and reporting it as protected would tell an operator their work is
 * safe further along than it is.
 */
export function contiguousProtectedSeconds(
  plan: EpochPlan,
  completed: readonly number[],
): number {
  const present = new Set(completed);
  let count = 0;
  while (count < plan.epochs.length && present.has(count)) count += 1;
  return protectedSecondsAfter(plan, count);
}

/** A wait that gives up the moment the job is cancelled. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The epoch build was cancelled.");
  error.name = "AbortError";
  return error;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--:--";
  const whole = Math.floor(seconds);
  const hours = String(Math.floor(whole / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const rest = String(whole % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}
