import path from "node:path";
import { packageAdaptiveRendition } from "../../../renditions/adaptive/packager";
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
  status: "succeeded" | "failed" | "cancelled";
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

      await store.update(job.id, { state: "running", startedAt: new Date() });
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
      await enterStage(
        job,
        "video",
        `Encoding ${decision.ladder.map((rung) => `${rung.qualityHeight}p`).join(", ")} ` +
          `${decision.videoCodec === "hevc" ? "HEVC" : "H.264"} with ${hardware.adapters.find((adapter) => adapter.id === decision.hardwareAdapter)?.label ?? decision.hardwareAdapter}`,
      );
      if (await cancelled()) return finishCancelled();

      const durationSeconds = probe.durationSeconds;
      let lastOverall = job.overallProgress;

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
      const cancellationWatch = setInterval(() => {
        void cancelled().then((isCancelled) => {
          if (isCancelled && !encodeAbort.signal.aborted) encodeAbort.abort();
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
            signal: encodeAbort.signal,
            onEvent: (event) => {
              if (event.type !== "encode-progress") return;
              const fraction =
                durationSeconds > 0
                  ? Math.min(1, event.processedSeconds / durationSeconds)
                  : 0;
              const next = overallProgress("video", fraction);
              lastOverall = monotonicProgress(lastOverall, next);
              void store.update(job.id, {
                stage: "video",
                stageProgress: fraction,
                overallProgress: lastOverall,
                ...(event.writtenBytes === undefined
                  ? {}
                  : { bytesProcessed: event.writtenBytes }),
                speed: event.speed ?? null,
                fps: event.fps ?? null,
                etaSeconds: etaFrom(
                  event.processedSeconds,
                  durationSeconds,
                  event.speed,
                ),
              });
            },
          },
        );
      } finally {
        clearInterval(cancellationWatch);
        input.signal?.removeEventListener("abort", forwardAbort);
      }

      if (await cancelled()) return finishCancelled();
      if (result.status === "interrupted") return finishCancelled();

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
