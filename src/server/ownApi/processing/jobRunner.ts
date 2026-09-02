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
import { RenditionLockHeldError } from "../../../renditions/locks";
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
import {
  createSpeedEstimator,
  estimateEncodeEtaSeconds,
} from "../../../renditions/adaptive/epochs/progress";
import { formatClock } from "../../../renditions/adaptive/epochs/engine";
import type { ProcessingJobRecord, ProcessingJobStore } from "./jobStore";
import {
  clearLiveProgress,
  writeLiveProgress,
  type BuildPhase,
  type LiveProgressSnapshot,
} from "./liveProgress";
import {
  monotonicProgress,
  overallProgress,
  type ProcessingStage,
} from "./stages";

/**
 * Which durable stage each build phase belongs to.
 *
 * The phases the packager reports are finer than the stages the job record has
 * always carried, and the record's vocabulary is what history rows, the
 * timeline and every existing test are written against. Mapping rather than
 * renaming keeps both honest: `assembling` is the packaging stage, and an
 * operator watching sees the word that describes what is happening.
 */
const STAGE_FOR_PHASE: Readonly<Record<BuildPhase, ProcessingStage>> = {
  planning: "planning",
  encoding: "video",
  audio: "audio",
  subtitles: "subtitles",
  assembling: "packaging",
  validating: "validating",
  publishing: "publishing",
};

const PHASE_MESSAGES: Readonly<Record<BuildPhase, string>> = {
  planning: "Planning the checkpointed encode.",
  encoding: "Encoding the video ladder.",
  audio: "Encoding audio.",
  subtitles: "Converting subtitles.",
  assembling:
    "Assembling the checkpointed epochs into the final renditions. No video is re-encoded.",
  validating: "Validating the assembled package.",
  publishing: "Publishing the verified package.",
};

/**
 * How often the running job's row is written while the encoder reports.
 *
 * FFmpeg reports four times a second. Writing that to the database for hours,
 * per title, would be sustained write pressure for data nothing needs to
 * survive a restart — the durable progress is the checkpoints on disk. The fast
 * lane goes to the live-progress file instead; this is the slow one.
 */
export const PERSIST_INTERVAL_MS = 1_000;

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
  softwareThreads?: number;
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
  /** Which roots failed their last check, so an error can name the drive. */
  missingRootsFn?: () => readonly string[];
  /**
   * Nominal epoch length. Five minutes in production; a deployment with very
   * short titles or very slow storage can shorten it, at the cost of one FFmpeg
   * start and one validation pass more often.
   */
  epochTargetSeconds?: number;
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
  /**
   * Set when the failure is a condition of the moment rather than a defect in
   * the job — another attempt holding the rendition lock is the case that
   * matters. Such a job must go back on the queue: failing it outright leaves
   * a perfectly processable title needing a person to notice and requeue it.
   */
  retryable?: boolean;
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

export function createProcessingJobRunner(deps: ProcessingJobRunnerDeps) {
  const {
    store,
    paths,
    ffmpegPath = process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg",
    ffprobePath = process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe",
    softwareThreads,
    detectHardwareFn = detectHardware,
    packageFn = packageAdaptiveRendition,
    probeFn = probeMediaFile,
    freeBytesFn = freeBytesOn,
    storageAvailableFn,
    missingRootsFn,
    epochTargetSeconds,
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

      const fail = async (code: string, message: string, retryable = false) => {
        await clearLiveProgress(job.id);
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
          ...(retryable ? { retryable: true } : {}),
        };
      };

      const cancelled = async () => {
        if (input.signal?.aborted) return true;
        if (await input.isCancelled?.()) return true;
        const latest = await store.get(job.id);
        return latest?.cancellationRequested === true;
      };

      const finishCancelled = async () => {
        await clearLiveProgress(job.id);
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
      const finishStorageInterrupted = async (detail?: string) => {
        /*
         * The live sample goes but the durable row keeps its epoch position, so
         * a page opened while the drive is missing still says how much work is
         * protected and which five minutes will be redone.
         */
        await clearLiveProgress(job.id);
        await store.update(job.id, {
          state: "paused",
          /*
           * The reason is what makes the pause recoverable.
           * `requeueStorageInterruptedJobs` looks for work with
           * `listPaused("storage-unavailable")`, which reads this column. The
           * encoder classifies an I/O error as storage loss before the watchdog
           * has polled, so without stamping it here that ordinary path leaves a
           * job paused with no reason, no error and nothing that will ever pick
           * it up again.
           */
          pausedReason: "storage-unavailable",
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
          message: detail
            ? `Waiting for storage. ${detail} Every completed checkpoint is untouched; only the epoch that was running will be built again.`
            : "Waiting for storage. Every completed checkpoint is untouched; only the epoch that was running will be built again.",
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
        sourceDurationSeconds: probe.durationSeconds,
        // Shown beside the protected bytes so an operator can see the headroom
        // the rest of the ladder has to fit into.
        ...(freeBytes === undefined ? {} : { freeBytes }),
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

      /*
       * The live sample, kept in memory and republished on every change.
       *
       * Held as one object rather than a handful of variables so the transient
       * file and the durable row can never describe different moments.
       */
      const live: {
        stage: ProcessingStage;
        phase: BuildPhase;
        epochIndex: number | null;
        epochCount: number | null;
        epochStartSeconds: number | null;
        epochEndSeconds: number | null;
        epochFraction: number | null;
        completedEpochs: number;
        protectedSeconds: number;
        encodedSeconds: number;
        sourceDurationSeconds: number;
        fps?: number;
        speed?: number;
        smoothedSpeed?: number;
        etaSeconds?: number;
        writtenBytes?: number;
      } = {
        stage: "video",
        phase: "planning",
        epochIndex: null,
        epochCount: null,
        epochStartSeconds: null,
        epochEndSeconds: null,
        epochFraction: null,
        completedEpochs: 0,
        protectedSeconds: 0,
        encodedSeconds: 0,
        sourceDurationSeconds: durationSeconds,
      };
      let revision = 0;
      let lastPersistMs = 0;
      let etaWasKnown = false;
      let checkpointBytesWritten = 0;
      let speed = createSpeedEstimator();

      const publishLive = (): Promise<void> => {
        revision += 1;
        const snapshot: LiveProgressSnapshot = {
          processingJobId: job.id,
          revision,
          timestampMs: Date.now(),
          stage: live.stage,
          phase: live.phase,
          epochIndex: live.epochIndex,
          epochCount: live.epochCount,
          epochStartSeconds: live.epochStartSeconds,
          epochEndSeconds: live.epochEndSeconds,
          epochFraction: live.epochFraction,
          completedEpochs: live.completedEpochs,
          protectedSeconds: live.protectedSeconds,
          encodedSeconds: live.encodedSeconds,
          sourceDurationSeconds: live.sourceDurationSeconds,
          ...(live.fps === undefined ? {} : { fps: live.fps }),
          ...(live.speed === undefined ? {} : { speed: live.speed }),
          ...(live.smoothedSpeed === undefined
            ? {}
            : { smoothedSpeed: live.smoothedSpeed }),
          ...(live.etaSeconds === undefined
            ? {}
            : { etaSeconds: live.etaSeconds }),
          ...(live.writtenBytes === undefined
            ? {}
            : { writtenBytes: live.writtenBytes }),
          encoder: decision.videoEncoder,
          qualityHeights: encodedRungs,
        };
        return writeLiveProgress(snapshot);
      };

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
            ...(softwareThreads === undefined ? {} : { softwareThreads }),
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
            ...(epochTargetSeconds === undefined ? {} : { epochTargetSeconds }),
            /*
             * The packager asks these at the moment something fails, which is
             * the only moment the answer distinguishes "the drive was pulled
             * out" from "this encode is broken".
             */
            ...(storageAvailableFn
              ? { storageAvailable: storageAvailableFn }
              : {}),
            ...(missingRootsFn ? { missingRoots: missingRootsFn } : {}),
            onEvent: (event) => {
              switch (event.type) {
                case "build-stage": {
                  /*
                   * The stages are shown apart rather than folded into one
                   * number. A job that has finished encoding and is assembling
                   * says so; it does not sit at a percentage that means neither
                   * thing.
                   */
                  live.phase = event.stage;
                  const stage = STAGE_FOR_PHASE[event.stage];
                  if (stage !== live.stage) {
                    live.stage = stage;
                    void store
                      .update(job.id, {
                        stage,
                        stageProgress: 0,
                        overallProgress: monotonicProgress(
                          lastOverall,
                          overallProgress(stage, 0),
                        ),
                      })
                      .catch(() => undefined);
                    void store
                      .appendEvent({
                        processingJobId: job.id,
                        stage,
                        message: PHASE_MESSAGES[event.stage],
                      })
                      .catch(() => undefined);
                  }
                  void publishLive();
                  return;
                }

                case "epoch-plan": {
                  live.epochCount = event.epochCount;
                  live.completedEpochs = event.reusedEpochs;
                  live.protectedSeconds = event.protectedSeconds;
                  live.encodedSeconds = event.protectedSeconds;
                  live.sourceDurationSeconds = event.sourceDurationSeconds;
                  // Seeded from what is already on disk, so "protected media"
                  // counts the checkpoints a resumed job inherited rather than
                  // only the ones this attempt produced.
                  checkpointBytesWritten = event.checkpointBytes;
                  void store
                    .update(job.id, {
                      checkpointBytes: event.checkpointBytes,
                      epochCount: event.epochCount,
                      completedEpochs: event.reusedEpochs,
                      protectedSeconds: event.protectedSeconds,
                      encodedSeconds: event.protectedSeconds,
                      sourceDurationSeconds: event.sourceDurationSeconds,
                    })
                    .catch(() => undefined);
                  void store
                    .appendEvent({
                      processingJobId: job.id,
                      stage: "video",
                      message:
                        event.reusedEpochs > 0
                          ? `Resuming from ${event.reusedEpochs} of ${event.epochCount} checkpoints; protected through ${formatClock(event.protectedSeconds)}.`
                          : `Encoding in ${event.epochCount} checkpointed ${event.epochCount === 1 ? "epoch" : "epochs"} of about ${Math.round(event.epochTargetSeconds / 60)} minutes.`,
                      detail: {
                        epochCount: event.epochCount,
                        reusedEpochs: event.reusedEpochs,
                        invalidated: event.invalidated,
                      },
                    })
                    .catch(() => undefined);
                  for (const entry of event.invalidated) {
                    void store
                      .appendEvent({
                        processingJobId: job.id,
                        stage: "video",
                        level: "warning",
                        message: `Checkpoint ${entry.index + 1} could not be trusted (${entry.reason}) and will be built again.`,
                      })
                      .catch(() => undefined);
                  }
                  void publishLive();
                  return;
                }

                case "epoch-start": {
                  live.epochIndex = event.index;
                  live.epochStartSeconds = event.startSeconds;
                  live.epochEndSeconds = event.endSeconds;
                  live.epochFraction = 0;
                  // A new epoch is a new encoder run, so the throughput estimate
                  // starts again rather than carrying the previous epoch's
                  // startup samples into this one's ETA.
                  speed = createSpeedEstimator();
                  void store
                    .update(job.id, {
                      epochIndex: event.index,
                      epochStartSeconds: event.startSeconds,
                      epochEndSeconds: event.endSeconds,
                    })
                    .catch(() => undefined);
                  void store
                    .appendEvent({
                      processingJobId: job.id,
                      stage: "video",
                      message: `${event.attempt > 1 ? "Retrying" : "Encoding"} epoch ${event.index + 1}/${event.epochCount} (${formatClock(event.startSeconds)}–${formatClock(event.endSeconds)})`,
                    })
                    .catch(() => undefined);
                  void publishLive();
                  return;
                }

                case "epoch-progress": {
                  live.epochIndex = event.index;
                  live.epochCount = event.epochCount;
                  live.epochStartSeconds = event.startSeconds;
                  live.epochEndSeconds = event.endSeconds;
                  live.protectedSeconds = event.protectedSeconds;
                  live.encodedSeconds = event.encodedSeconds;
                  live.sourceDurationSeconds = event.sourceDurationSeconds;
                  const window = event.endSeconds - event.startSeconds;
                  live.epochFraction =
                    window > 0
                      ? Math.min(
                          1,
                          Math.max(0, event.epochProcessedSeconds / window),
                        )
                      : 0;
                  live.fps = event.fps;
                  live.speed = event.speed;
                  live.smoothedSpeed = speed.sample(event.speed);
                  live.etaSeconds = estimateEncodeEtaSeconds({
                    encodedSeconds: event.encodedSeconds,
                    sourceDurationSeconds: event.sourceDurationSeconds,
                    smoothedSpeed: live.smoothedSpeed,
                  });
                  live.writtenBytes = event.writtenBytes;

                  const fraction =
                    durationSeconds > 0
                      ? Math.min(1, event.encodedSeconds / durationSeconds)
                      : 0;
                  lastOverall = monotonicProgress(
                    lastOverall,
                    overallProgress("video", fraction),
                  );
                  /*
                   * The estimate is refined here rather than in the browser so
                   * every reader — page, history, API — sees one number. It
                   * starts as the plan and moves toward what the encoder is
                   * actually producing as the evidence accumulates.
                   */
                  if (event.writtenBytes !== undefined) {
                    lastEstimateBytes = estimateFinalOutputBytes({
                      plannedBytes: decision.estimate.outputBytes,
                      actualBytes: event.writtenBytes,
                      progressFraction: fraction,
                      processedSeconds: event.encodedSeconds,
                      ...(lastEstimateBytes === undefined
                        ? {}
                        : { previousEstimate: lastEstimateBytes }),
                    });
                  }

                  // The transient lane runs at the encoder's own rate; the
                  // durable one is deliberately much slower — except that an
                  // estimate appearing for the first time is a state change
                  // rather than a sample, and a page that reconnects before the
                  // next tick should already see it.
                  void publishLive();
                  const etaBecameKnown =
                    (live.etaSeconds !== undefined) !== etaWasKnown;
                  if (
                    etaBecameKnown ||
                    Date.now() - lastPersistMs >= PERSIST_INTERVAL_MS
                  ) {
                    etaWasKnown = live.etaSeconds !== undefined;
                    lastPersistMs = Date.now();
                    void store
                      .update(job.id, {
                        stage: "video",
                        stageProgress: fraction,
                        overallProgress: lastOverall,
                        encodedSeconds: event.encodedSeconds,
                        protectedSeconds: event.protectedSeconds,
                        epochIndex: event.index,
                        ...(event.writtenBytes === undefined
                          ? {}
                          : { bytesProcessed: event.writtenBytes }),
                        ...(lastEstimateBytes === undefined
                          ? {}
                          : { estimatedOutputBytes: lastEstimateBytes }),
                        speed: event.speed ?? null,
                        fps: event.fps ?? null,
                        etaSeconds: live.etaSeconds ?? null,
                      })
                      .catch(() => undefined);
                  }
                  return;
                }

                case "epoch-complete": {
                  live.completedEpochs = Math.max(
                    live.completedEpochs,
                    event.index + 1,
                  );
                  live.protectedSeconds = event.protectedSeconds;
                  live.encodedSeconds = Math.max(
                    live.encodedSeconds,
                    event.protectedSeconds,
                  );
                  checkpointBytesWritten += event.bytes;
                  void store
                    .update(job.id, {
                      completedEpochs: live.completedEpochs,
                      protectedSeconds: event.protectedSeconds,
                      encodedSeconds: live.encodedSeconds,
                      checkpointBytes: checkpointBytesWritten,
                    })
                    .catch(() => undefined);
                  if (event.bytes > 0) {
                    void store
                      .appendEvent({
                        processingJobId: job.id,
                        stage: "video",
                        message: `Checkpoint saved — protected through ${formatClock(event.protectedSeconds)} (${event.index + 1}/${event.epochCount})`,
                      })
                      .catch(() => undefined);
                  }
                  void publishLive();
                  return;
                }

                case "source-io-retry": {
                  void store
                    .appendEvent({
                      processingJobId: job.id,
                      stage: "video",
                      level: "warning",
                      message: `Epoch ${event.index + 1} could not be read (attempt ${event.attempt} of ${event.maxAttempts}); the volume was re-checked and is still available, so the read is being retried.`,
                      detail: {
                        epochIndex: event.index,
                        attempt: event.attempt,
                        maxAttempts: event.maxAttempts,
                        ...(event.sourceReadable === undefined
                          ? {}
                          : { sourceReadable: event.sourceReadable }),
                        error: event.detail,
                      },
                    })
                    .catch(() => undefined);
                  return;
                }

                case "epoch-invalid": {
                  void store
                    .appendEvent({
                      processingJobId: job.id,
                      stage: "video",
                      level: "warning",
                      message: `Epoch ${event.index + 1} did not pass its checks and will be built again: ${event.reason}`,
                    })
                    .catch(() => undefined);
                  return;
                }

                default:
                  return;
              }
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
          error instanceof RenditionLockHeldError,
        );
      } finally {
        clearInterval(cancellationWatch);
        input.signal?.removeEventListener("abort", forwardAbort);
      }

      /*
       * The packager now says *why* it stopped. A cancellation and a vanished
       * volume both end the encoder with an abort, and only one of them is a
       * reason to mark the job cancelled.
       */
      if (result.interruption === "storage") {
        return finishStorageInterrupted(result.error);
      }
      if (storageInterrupted && result.status === "interrupted") {
        return finishStorageInterrupted();
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
        /*
         * The verdict alone is useless to whoever has to fix it. The package is
         * discarded on a validation failure, so this message is the only
         * surviving evidence of what was wrong with it.
         */
        return fail(
          PROCESSING_ERROR_CODES.validationFailed,
          result.error ??
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
      await clearLiveProgress(job.id);
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
