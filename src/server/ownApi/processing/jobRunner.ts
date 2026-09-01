import path from "node:path";
import { createPauseController } from "../../../renditions/processing/pauseController";
import { planRetainedSidecarSubtitles } from "../../../renditions/adaptive/processor";
import { packageAdaptiveRendition } from "../../../renditions/adaptive/packager";
import { estimateFinalOutputBytes } from "../../../renditions/outputEstimate";
import type { AdaptivePackageResult } from "../../../renditions/adaptive/packager";
import {
  detectHardware,
  type HardwareReport,
} from "../../../renditions/hardware/detect";
import type { RenditionPaths } from "../../../renditions/analysis";
import { probeMediaFile } from "../../../renditions/probe";
import {
  loadRenditionRegistry,
  saveRenditionRegistry,
  upsertRegistrySource,
} from "../../../renditions/registry";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import {
  decideProcessing,
  freeBytesOn,
  type ProcessingDecision,
} from "../../../renditions/processing/decide";
import type { ProcessingJobRecord, ProcessingJobStore } from "./jobStore";
import {
  monotonicProgress,
  overallProgress,
  type ProcessingStage,
} from "./stages";

/**
 * Runs one processing job from analysis to publication.
 *
 * Every stage transition and every progress update goes through the store, so
 * the record on disk is always what the UI would show — a worker that dies
 * leaves a job whose last honest state is already persisted, rather than one
 * whose progress lived only in memory.
 */

export interface ProcessingJobRunnerDeps {
  store: ProcessingJobStore;
  paths: RenditionPaths;
  mediaRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Injected in tests so nothing spawns FFmpeg. */
  detectHardwareFn?: typeof detectHardware;
  packageFn?: typeof packageAdaptiveRendition;
  probeFn?: typeof probeMediaFile;
  /** Free bytes on the output volume. Injected so tests can force a shortfall. */
  freeBytesFn?: typeof freeBytesOn;
  /**
   * Whether the storage this work needs is currently available.
   *
   * Consulted when an encode fails, because the failure a vanished volume
   * produces is an ordinary-looking `ENOENT` on an output path — indisting-
   * uishable by its code from a genuinely missing file. Asking the storage
   * itself is the only reliable way to tell "the drive was unplugged" from
   * "this source is gone", and getting that wrong turned every accidental
   * disconnect into a permanent failure.
   */
  storageAvailableFn?: () => boolean | Promise<boolean>;
  now?: () => number;
}

export interface RunProcessingJobInput {
  processingJobId: string;
  sourcePath: string;
  relativePath: string;
  sizeBytes: number;
  mtimeMs: number;
  signal?: AbortSignal;
  isCancelled?: () => Promise<boolean>;
}

export interface RunProcessingJobOutcome {
  /**
   * `waiting-for-storage` is a recoverable outcome, not an ending: the job is
   * paused with its reason recorded and will be requeued automatically once
   * the volume it needs is back.
   */
  status: "succeeded" | "failed" | "cancelled" | "waiting-for-storage";
  decision?: ProcessingDecision;
  packageResult?: AdaptivePackageResult;
  errorCode?: string;
  errorMessage?: string;
}

/** Structured codes so the UI can offer the right next action. */
export const PROCESSING_ERROR_CODES = {
  sourceChanged: "SOURCE_CHANGED",
  noVideo: "NO_VIDEO_STREAM",
  tooSmall: "SOURCE_TOO_SMALL",
  insufficientSpace: "INSUFFICIENT_DISK_SPACE",
  validationFailed: "VALIDATION_FAILED",
  encodeFailed: "ENCODE_FAILED",
  cancelled: "CANCELLED",
} as const;

function etaFrom(
  processedSeconds: number,
  durationSeconds: number,
  speed: number | undefined,
): number | null {
  if (!speed || speed <= 0 || durationSeconds <= 0) return null;
  const remaining = Math.max(0, durationSeconds - processedSeconds);
  const eta = remaining / speed;
  return Number.isFinite(eta) ? Math.round(eta) : null;
}

export function createProcessingJobRunner(deps: ProcessingJobRunnerDeps) {
  const {
    store,
    paths,
    ffmpegPath = process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg",
    ffprobePath = process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe",
    detectHardwareFn = detectHardware,
    packageFn = packageAdaptiveRendition,
    probeFn = probeMediaFile,
    freeBytesFn = freeBytesOn,
    storageAvailableFn,
  } = deps;

  async function enterStage(
    job: ProcessingJobRecord,
    stage: ProcessingStage,
    message: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await store.update(job.id, {
      stage,
      stageProgress: 0,
      overallProgress: overallProgress(stage, 0),
    });
    await store.appendEvent({
      processingJobId: job.id,
      stage,
      message,
      ...(detail ? { detail } : {}),
    });
  }

  return {
    async run(input: RunProcessingJobInput): Promise<RunProcessingJobOutcome> {
      const job = await store.get(input.processingJobId);
      if (!job) {
        return {
          status: "failed",
          errorCode: "JOB_NOT_FOUND",
          errorMessage: "The processing job no longer exists.",
        };
      }

      const fail = async (code: string, message: string) => {
        await store.update(job.id, {
          state: "failed",
          errorCode: code,
          errorMessage: message,
          finishedAt: new Date(),
        });
        await store.appendEvent({
          processingJobId: job.id,
          stage: job.stage,
          level: "error",
          message,
        });
        return {
          status: "failed" as const,
          errorCode: code,
          errorMessage: message,
        };
      };

      const cancelled = async () => {
        if (input.signal?.aborted) return true;
        if (await input.isCancelled?.()) return true;
        const latest = await store.get(job.id);
        return latest?.cancellationRequested === true;
      };

      const finishCancelled = async () => {
        await store.update(job.id, {
          state: "cancelled",
          errorCode: PROCESSING_ERROR_CODES.cancelled,
          errorMessage: "Processing was cancelled.",
          finishedAt: new Date(),
        });
        await store.appendEvent({
          processingJobId: job.id,
          stage: "waiting",
          level: "warning",
          message:
            "Processing was cancelled. Any published package is untouched.",
        });
        return { status: "cancelled" as const };
      };

      /**
       * The encode stopped because its storage went away.
       *
       * Deliberately not a failure: nothing is wrong with the source, the plan
       * or the package, and marking it failed is what forced a person to press
       * Retry after every accidental unplug. The job stays paused with the
       * reason recorded, keeps no finish time because it has not finished, and
       * is picked up again automatically when the volume returns.
       */
      const finishStorageInterrupted = async () => {
        await store.update(job.id, {
          state: "paused",
          // It has not finished, so it must not carry a finish time.
          finishedAt: null,
          speed: null,
          fps: null,
          etaSeconds: null,
          errorCode: null,
          errorMessage: null,
        });
        await store.appendEvent({
          processingJobId: job.id,
          stage: "waiting",
          level: "warning",
          message:
            "Waiting for storage. Published renditions are untouched; the interrupted rendition will be built again when the volume returns.",
        });
        return { status: "waiting-for-storage" as const };
      };

      /*
       * An attempt begins here whether it arrived through a retry or through
       * the queue re-leasing an abandoned job, so the invariants are enforced
       * at the point work actually starts rather than only on one path. A
       * running attempt cannot carry a finish time, and its progress and
       * telemetry describe this attempt alone — the previous one's 89% must
       * not make a run that has just begun look nearly done.
       */
      await store.update(job.id, {
        state: "running",
        startedAt: new Date(),
        finishedAt: null,
        stageProgress: 0,
        overallProgress: 0,
        speed: null,
        fps: null,
        etaSeconds: null,
        validation: null,
        errorCode: null,
        errorMessage: null,
      });
      await store.incrementAttempts(job.id);

      // ---------------------------------------------------------- analysing
      await enterStage(job, "analysing", "Analysing the source.");
      if (await cancelled()) return finishCancelled();

      let probe: Awaited<ReturnType<typeof probeMediaFile>>;
      try {
        probe = await probeFn(input.sourcePath, ffprobePath, input.signal);
      } catch (error) {
        return fail(
          PROCESSING_ERROR_CODES.noVideo,
          error instanceof Error
            ? error.message
            : "The source could not be probed.",
        );
      }
      await store.appendEvent({
        processingJobId: job.id,
        stage: "analysing",
        message: `Analysing ${probe.audioTracks.length} audio and ${probe.subtitleTracks.length} subtitle ${probe.subtitleTracks.length === 1 ? "track" : "tracks"}`,
      });
      await store.update(job.id, {
        stageProgress: 1,
        overallProgress: overallProgress("analysing", 1),
      });

      // ----------------------------------------------------------- planning
      await enterStage(job, "planning", "Choosing the processing plan.");
      if (await cancelled()) return finishCancelled();

      let hardware: HardwareReport;
      try {
        hardware = await detectHardwareFn({
          ffmpegPath,
          probeWidth: 1920,
          probeHeight: 1080,
          ...(input.signal ? { signal: input.signal } : {}),
        });
      } catch {
        return fail(
          PROCESSING_ERROR_CODES.encodeFailed,
          "No usable video encoder was found on this machine.",
        );
      }

      const freeBytes = await freeBytesFn(paths.renditionRoot);
      const decision = decideProcessing({
        probe,
        container: path.extname(input.sourcePath).replace(".", ""),
        sizeBytes: input.sizeBytes,
        hardware,
        ...(freeBytes === undefined ? {} : { freeBytes }),
      });

      await store.update(job.id, {
        hardwareAdapter: decision.hardwareAdapter,
        videoEncoder: decision.videoEncoder,
        warnings: decision.warnings,
        stageProgress: 1,
        overallProgress: overallProgress("planning", 1),
      });
      await store.appendEvent({
        processingJobId: job.id,
        stage: "planning",
        message: decision.summary,
        detail: { decision: decision as unknown as Record<string, unknown> },
      });
      for (const entry of decision.streams.audio) {
        await store.appendEvent({
          processingJobId: job.id,
          stage: "planning",
          message: entry.explanation,
        });
      }
      for (const entry of decision.streams.subtitles) {
        await store.appendEvent({
          processingJobId: job.id,
          stage: "planning",
          message: entry.explanation,
          ...(entry.requiresOcr ? { level: "warning" as const } : {}),
        });
      }

      if (decision.action === "reject-no-video") {
        return fail(PROCESSING_ERROR_CODES.noVideo, decision.summary);
      }
      if (decision.action === "reject-too-small") {
        return fail(PROCESSING_ERROR_CODES.tooSmall, decision.summary);
      }
      if (!decision.estimate.sufficient) {
        return fail(
          PROCESSING_ERROR_CODES.insufficientSpace,
          "There is not enough free space for this package and its staging copy.",
        );
      }

      // ------------------------------------------------- video/audio/subs
      /*
       * The diagnostics name the rungs this run will encode, not the ladder the
       * finished package holds. Logging the whole ladder for a one-rung job was
       * how a job that encoded only 1440p still read as "Encoding 2160p, 1440p,
       * 1080p, ..." in its own history.
       */
      const encodedRungs =
        decision.renditionsToEncode && decision.renditionsToEncode.length > 0
          ? decision.renditionsToEncode
          : decision.ladder.map((rung) => rung.qualityHeight);
      await enterStage(
        job,
        "video",
        `Encoding ${encodedRungs.map((height) => `${height}p`).join(", ")} ` +
          `${decision.videoCodec === "hevc" ? "HEVC" : "H.264"} with ${hardware.adapters.find((adapter) => adapter.id === decision.hardwareAdapter)?.label ?? decision.hardwareAdapter}`,
      );
      if (await cancelled()) return finishCancelled();

      const durationSeconds = probe.durationSeconds;
      // Scoped to this attempt: the record was just reset, and the in-memory
      // `job` still holds the previous attempt's figure.
      let lastOverall = 0;
      /** This job's current guess at its own final size, refined as it runs. */
      let lastEstimateBytes: number | undefined;

      /**
       * The rendition registry, not the catalogue, owns the identity a package
       * is stored under.
       *
       * The playback service finds a package by looking the source up in the
       * registry and reading `<renditionRoot>/<registryItem.id>`. Packaging
       * under the catalogue's own file id would produce a perfectly valid
       * package in a directory nothing ever looks in.
       */
      const registryPath = path.join(paths.stateRoot, "registry.json");
      const registry = await loadRenditionRegistry(registryPath);
      const registryItem = upsertRegistrySource(registry, {
        relativePath: input.relativePath,
        size: input.sizeBytes,
        mtimeMs: input.mtimeMs,
        sourceFingerprint: job.sourceFingerprint,
      });
      await saveRenditionRegistry(registryPath, registry);

      /**
       * Cancellation has to reach FFmpeg, not just the loop around it.
       *
       * The queue reports cancellation through a polled predicate, while the
       * packager takes an `AbortSignal` that it forwards to the encoder.
       * Without this bridge a cancelled job kept encoding to the end and only
       * noticed afterwards, which to an operator is indistinguishable from the
       * request being ignored.
       */
      const encodeAbort = new AbortController();
      const forwardAbort = () => encodeAbort.abort();
      input.signal?.addEventListener("abort", forwardAbort, { once: true });

      /*
       * Pause travels the same way cancellation does, for the same reason: the
       * request is made in one process and the encoder runs in another, so a
       * polled flag is the only channel between them. Unlike cancellation it
       * suspends rather than kills, so the work already done survives.
       */
      const pauseController = createPauseController();
      /*
       * Set when the encode is stopped because its storage disappeared, so the
       * outcome can be told apart from a person cancelling. The two look
       * identical to the encoder — both end in an abort — and conflating them
       * is what turned an unplugged drive into a permanently failed job.
       */
      let storageInterrupted = false;
      const cancellationWatch = setInterval(() => {
        /*
         * Every line below talks to the database, and a database that blinks —
         * a restart, a dropped idle socket, a query timeout — rejects them. A
         * rejection from a timer is nobody's to catch, so before this `catch`
         * existed it reached the process as an unhandled rejection and ended
         * the server mid-encode. The tick is a poll: missing one costs a second
         * of latency on a pause request, and nothing else.
         */
        void (async () => {
          const latest = await store.get(job.id);
          if (
            latest?.pauseRequested &&
            latest.pausedReason === "storage-unavailable" &&
            !storageInterrupted
          ) {
            /*
             * Suspending is the wrong move here, and used to be what happened.
             * A stopped FFmpeg keeps its file descriptors open on a volume that
             * is no longer there, and resuming it later would carry on writing
             * through handles that may now point at a different disk entirely.
             * The encoder is ended instead: its partial output is discarded on
             * recovery and only the interrupted rendition is built again, while
             * every published rendition is left exactly as it is.
             */
            storageInterrupted = true;
            pauseController.resume();
            encodeAbort.abort();
            await store.update(job.id, { state: "paused" });
            await store.appendEvent({
              processingJobId: job.id,
              stage: latest.stage,
              level: "warning",
              message:
                "Storage became unavailable; the encoder was stopped and the job is waiting for it to return.",
            });
          } else if (latest?.pauseRequested && !pauseController.paused) {
            pauseController.pause();
            await store.update(job.id, { state: "paused" });
            await store.appendEvent({
              processingJobId: job.id,
              stage: latest.stage,
              level: "warning",
              message: "Paused.",
            });
          } else if (
            latest &&
            !latest.pauseRequested &&
            pauseController.paused
          ) {
            pauseController.resume();
            await store.update(job.id, { state: "running" });
            await store.appendEvent({
              processingJobId: job.id,
              stage: latest.stage,
              level: "info",
              message: "Resumed.",
            });
          }

          if ((await cancelled()) && !encodeAbort.signal.aborted) {
            // A suspended encoder cannot notice an abort, so lift the pause
            // first and let the abort reach it.
            pauseController.resume();
            encodeAbort.abort();
          }
        })().catch((error) => {
          console.warn(
            "[Seyirlik] Could not read the pause state for a processing job:",
            error instanceof Error ? error.message : String(error),
          );
        });
      }, 1000);
      if (typeof cancellationWatch.unref === "function")
        cancellationWatch.unref();

      let result: Awaited<ReturnType<typeof packageFn>>;
      try {
        result = await packageFn(
          {
            mediaId: registryItem.id,
            relativePath: input.relativePath,
            sourceFingerprint: job.sourceFingerprint,
            sourcePath: input.sourcePath,
            probe,
          },
          paths,
          {
            ffmpegPath,
            ffprobePath,
            reserveBytes: decision.estimate.reserveBytes,
            videoEncoder: decision.videoEncoder,
            hdrVideoEncoder: decision.videoEncoder,
            audioStreamIndexes: decision.streams.keptAudioStreamIndexes,
            subtitleStreamIndexes: decision.streams.keptSubtitleStreamIndexes,
            /*
             * Most of this library is subtitled with a `.srt` beside the file
             * rather than a stream inside it. Without this the server path
             * publishes titles with no subtitles in a retained language while
             * the offline CLI, running the same policy, publishes them with —
             * the same title processed two ways giving two different answers.
             */
            sidecarSubtitles: await planRetainedSidecarSubtitles(
              input.sourcePath,
            ),
            signal: encodeAbort.signal,
            pauseController,
            onEvent: (event) => {
              if (event.type !== "encode-progress") return;
              const fraction =
                durationSeconds > 0
                  ? Math.min(1, event.processedSeconds / durationSeconds)
                  : 0;
              const next = overallProgress("video", fraction);
              lastOverall = monotonicProgress(lastOverall, next);
              /*
               * The estimate is refined here rather than in the browser so
               * every reader — page, history, API — sees one number. It starts
               * as the plan and moves toward what the encoder is actually
               * producing as the evidence accumulates.
               */
              if (event.writtenBytes !== undefined) {
                lastEstimateBytes = estimateFinalOutputBytes({
                  plannedBytes: decision.estimate.outputBytes,
                  actualBytes: event.writtenBytes,
                  progressFraction: fraction,
                  processedSeconds: event.processedSeconds,
                  ...(lastEstimateBytes === undefined
                    ? {}
                    : { previousEstimate: lastEstimateBytes }),
                });
              }
              // Progress is written without waiting so the encoder is never
              // paced by the database, and its failure is swallowed for the
              // same reason it is not awaited: the next event overwrites it a
              // second later. Unhandled, that same rejection ended the process.
              void store
                .update(job.id, {
                  stage: "video",
                  stageProgress: fraction,
                  overallProgress: lastOverall,
                  ...(event.writtenBytes === undefined
                    ? {}
                    : { bytesProcessed: event.writtenBytes }),
                  ...(lastEstimateBytes === undefined
                    ? {}
                    : { estimatedOutputBytes: lastEstimateBytes }),
                  speed: event.speed ?? null,
                  fps: event.fps ?? null,
                  etaSeconds: etaFrom(
                    event.processedSeconds,
                    durationSeconds,
                    event.speed,
                  ),
                })
                .catch(() => undefined);
            },
          },
        );
      } catch (error) {
        /*
         * A throw from the packager used to escape this function entirely, so
         * nothing was written to the job's own diagnostics and the row was
         * back-filled later with a generic worker-stopped message. The reason
         * the encode never started — a held rendition lock, a vanished drive —
         * is exactly what a person opening the details is looking for, so it
         * is recorded here where it is still known.
         */
        return fail(
          PROCESSING_ERROR_CODES.encodeFailed,
          error instanceof Error
            ? error.message
            : "The encoder stopped before the package was built.",
        );
      } finally {
        clearInterval(cancellationWatch);
        input.signal?.removeEventListener("abort", forwardAbort);
      }

      if (await cancelled()) return finishCancelled();
      if (result.status === "interrupted") {
        return storageInterrupted
          ? finishStorageInterrupted()
          : finishCancelled();
      }

      // ------------------------------------------------------- validating
      await enterStage(job, "validating", "Validating the package.");
      if (result.status === "validation-failed") {
        await store.update(job.id, {
          validation: { ok: false, issues: result.issues ?? [] },
        });
        return fail(
          PROCESSING_ERROR_CODES.validationFailed,
          "The package failed validation and was not published.",
        );
      }
      if (result.status === "failed" || result.status === "incompatible") {
        // The storage is asked directly rather than inferred from the error.
        if (storageAvailableFn && !(await storageAvailableFn())) {
          return finishStorageInterrupted();
        }
        return fail(
          PROCESSING_ERROR_CODES.encodeFailed,
          result.error ?? "The package could not be produced.",
        );
      }
      if (result.status === "deferred-for-storage") {
        return fail(
          PROCESSING_ERROR_CODES.insufficientSpace,
          "Processing stopped because the output volume ran short of space.",
        );
      }

      await store.update(job.id, {
        validation: { ok: true, issues: [] },
        stageProgress: 1,
        overallProgress: overallProgress("validating", 1),
      });

      // -------------------------------------------------------- publishing
      await enterStage(job, "publishing", "Publishing the verified package.");
      await store.update(job.id, {
        state: "succeeded",
        stage: "complete",
        stageProgress: 1,
        overallProgress: 1,
        ...(result.versionDirectory
          ? { publishedVersion: result.versionDirectory }
          : {}),
        /*
         * On success the size is no longer predicted, it is known. Actual and
         * estimated converge so a finished row cannot show two different
         * numbers for the same thing.
         */
        ...(result.jobOutputBytes === undefined
          ? {}
          : {
              bytesProcessed: result.jobOutputBytes,
              estimatedOutputBytes: result.jobOutputBytes,
            }),
        ...(result.storageBytes === undefined
          ? {}
          : { outputBytes: result.storageBytes }),
        speed: null,
        fps: null,
        etaSeconds: 0,
        finishedAt: new Date(),
      });
      registryItem.adaptiveStatus = "ready";
      registryItem.adaptiveProfileVersion = ADAPTIVE_PROFILE_VERSION;
      delete registryItem.adaptiveLastError;
      await saveRenditionRegistry(registryPath, registry);

      await store.appendEvent({
        processingJobId: job.id,
        stage: "complete",
        message:
          result.status === "already-valid"
            ? "A current package already existed; nothing needed rebuilding."
            : "Published the verified package.",
        ...(result.versionDirectory
          ? { detail: { versionDirectory: result.versionDirectory } }
          : {}),
      });

      return { status: "succeeded", decision, packageResult: result };
    },
  };
}
