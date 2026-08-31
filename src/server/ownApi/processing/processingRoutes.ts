import { stat } from "node:fs/promises";
import path from "node:path";
import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyString,
  parseLimit,
  requireUuid,
} from "../api/validation";
import { isPathInsideRoot } from "../../pathSecurity";
import { RENDITION_TARGETS } from "../../../renditions/policy";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { JobQueue } from "../tasks/jobQueue";
import {
  detectHardware,
  type HardwareReport,
} from "../../../renditions/hardware/detect";
import { probeMediaFile } from "../../../renditions/probe";
import { computeSourceFingerprint } from "../../../renditions/registry";
import {
  decideProcessing,
  freeBytesOn,
  type ProcessingDecision,
} from "../../../renditions/processing/decide";
import { ADAPTIVE_PROFILE_VERSION } from "../../../renditions/adaptive/profile";
import { readTitlePackageManifest } from "../../../renditions/adaptive/publishTitle";
import {
  DuplicateProcessingJobError,
  type ProcessingJobRecord,
  type ProcessingJobStore,
  type ProcessingState,
} from "./jobStore";
import { PROCESSING_STAGES } from "./stages";

export const PROCESSING_JOB_TYPE = "media.process";

export interface ProcessingRoutesOptions {
  catalogue: CatalogueRepository;
  store: ProcessingJobStore;
  queue: JobQueue;
  mediaRoot: string;
  renditionRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  /**
   * Whether the media volume is currently mounted. Injected rather than probed
   * here so the routes and the watchdog cannot disagree about it.
   */
  storageAvailable?: () => boolean;
}

/**
 * Hardware is probed by encoding, which costs a second or two. The result only
 * changes when the machine does, so it is held briefly rather than re-probed on
 * every page load.
 */
const HARDWARE_CACHE_MS = 60_000;

function toJobDto(job: ProcessingJobRecord) {
  return {
    id: job.id,
    itemId: job.itemId,
    mediaFileId: job.mediaFileId,
    profile: job.profile,
    state: job.state,
    stage: job.stage,
    stageProgress: job.stageProgress,
    overallProgress: job.overallProgress,
    bytesProcessed: job.bytesProcessed,
    outputBytes: job.outputBytes,
    estimatedOutputBytes: job.estimatedOutputBytes,
    /*
     * Named for what they mean rather than for where they are stored.
     * `actualOutputBytes` is what this job has physically written; it is never
     * the package's size and never a prediction. `outputBytes` is kept as the
     * published package total for anything already reading it.
     */
    actualOutputBytes: job.bytesProcessed,
    estimatedStagingBytes: job.estimatedStagingBytes,
    speed: job.speed,
    fps: job.fps,
    etaSeconds: job.etaSeconds,
    hardwareAdapter: job.hardwareAdapter,
    videoEncoder: job.videoEncoder,
    decision: job.decision,
    validation: job.validation,
    warnings: job.warnings,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    publishedVersion: job.publishedVersion,
    attempts: job.attempts,
    cancellationRequested: job.cancellationRequested,
    pauseRequested: job.pauseRequested,
    pausedReason: job.pausedReason,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function createProcessingRoutes({
  catalogue,
  store,
  queue,
  mediaRoot,
  renditionRoot,
  ffmpegPath = process.env.SEYIRLIK_FFMPEG_PATH ?? "ffmpeg",
  ffprobePath = process.env.SEYIRLIK_FFPROBE_PATH ?? "ffprobe",
  storageAvailable = () => true,
}: ProcessingRoutesOptions): RouteDefinition[] {
  const resolvedMediaRoot = path.resolve(mediaRoot);
  let hardwareCache: { report: HardwareReport; at: number } | null = null;

  async function hardware(): Promise<HardwareReport> {
    if (hardwareCache && Date.now() - hardwareCache.at < HARDWARE_CACHE_MS) {
      return hardwareCache.report;
    }
    const report = await detectHardware({
      ffmpegPath,
      probeWidth: 1920,
      probeHeight: 1080,
    });
    hardwareCache = { report, at: Date.now() };
    return report;
  }

  /**
   * Where an item's bytes would live, whether or not they are still there.
   *
   * Locating and reading are separate steps because a source can be deleted
   * while the package built from it stays on disk: the path is still the only
   * way to find that package, so it is resolved before the file is opened.
   */
  async function locateSource(itemId: string, mediaFileId?: string) {
    const files = await catalogue.listFilesForItem(itemId);
    const file = mediaFileId
      ? files.find((candidate) => candidate.id === mediaFileId)
      : files[0];
    if (!file) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    const absolutePath = path.resolve(
      resolvedMediaRoot,
      ...file.relativePath.split("/"),
    );
    if (!isPathInsideRoot(resolvedMediaRoot, absolutePath)) {
      throw new OwnApiError(
        "MEDIA_NOT_FOUND",
        "The requested media could not be found.",
        404,
      );
    }
    return { file, absolutePath };
  }

  /**
   * The source's stats, or `null` when the source is gone.
   *
   * A deleted source is an ordinary state of the library, not a fault: `stat`
   * raising ENOENT used to reach the page as a bare internal error, which said
   * nothing about the package the title still has.
   */
  async function statSource(
    file: { missingSince: Date | null },
    absolutePath: string,
  ) {
    if (file.missingSince !== null) return null;
    try {
      return await stat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * What the title already holds, so a preview can describe the work that is
   * actually left rather than the work a bare source would need.
   *
   * Without this the preview listed the whole ladder for a title that already
   * carried every rung of it, which reads as "all of this is about to be
   * built" when the honest answer is "nothing is".
   */
  async function existingPackage(
    absolutePath: string,
    /** `null` when the source is gone, so nothing can be compared against it. */
    fingerprint: string | null,
  ) {
    const titleRoot = path.dirname(absolutePath);
    const manifest = await readTitlePackageManifest(titleRoot).catch(
      () => undefined,
    );
    if (!manifest) return { present: false as const };

    const sourceMatches =
      fingerprint !== null && manifest.sourceFingerprint === fingerprint;
    const rungs = manifest.video
      .map((rendition) => rendition.qualityHeight)
      .sort((left, right) => right - left);
    /*
     * Whether the package is a whole ladder, judged from the package alone.
     *
     * The source is what normally decides which rungs a title should have, and
     * it can be gone by the time anyone asks. Its own top rung stands in for
     * it: the ladder always reaches the source's class, so a package holding
     * every standard rung at or below its best one is not short of anything.
     */
    const complete = RENDITION_TARGETS.map((target) => target.qualityHeight)
      .filter((height) => height <= (rungs[0] ?? 0))
      .every((height) => rungs.includes(height));
    const profileMatches = manifest.profileVersion === ADAPTIVE_PROFILE_VERSION;
    return {
      present: true as const,
      current: sourceMatches && profileMatches,
      sourceMatches,
      profileMatches,
      rungs,
      complete,
      /*
       * The package's dynamic range, which is the only record of it once the
       * source is gone. A ladder is packaged in one transfer characteristic,
       * so the first rung that is not SDR names the whole package.
       */
      hdr:
        manifest.video.find((rendition) => rendition.hdr !== "sdr")?.hdr ??
        "sdr",
      audioTracks: manifest.audio.length,
      subtitleTracks: manifest.subtitle.length,
      totalBytes: manifest.storage.totalBytes,
    };
  }

  async function analyse(
    itemId: string,
    mediaFileId?: string,
  ): Promise<{
    decision: ProcessingDecision;
    fingerprint: string;
    file: Awaited<ReturnType<typeof locateSource>>["file"];
    absolutePath: string;
    mtimeMs: number;
    /** The package on disk, plus the rungs today's ladder would add to it. */
    existing: Awaited<ReturnType<typeof existingPackage>> & {
      missingRungs: number[];
    };
  }> {
    const { file, absolutePath } = await locateSource(itemId, mediaFileId);
    const stats = await statSource(file, absolutePath);
    if (!stats) {
      throw new OwnApiError(
        "SOURCE_UNAVAILABLE",
        "The source file for this title is no longer on disk.",
        409,
      );
    }
    const probe = await probeMediaFile(absolutePath, ffprobePath);
    const report = await hardware();
    const freeBytes = await freeBytesOn(renditionRoot);
    const fingerprint = await computeSourceFingerprint(absolutePath, stats);
    const existing = await existingPackage(absolutePath, fingerprint);
    const plan = {
      probe,
      container: path.extname(absolutePath).replace(".", ""),
      sizeBytes: stats.size,
      hardware: report,
      ...(freeBytes === undefined ? {} : { freeBytes }),
    };

    /*
     * What this source would be built into today, before asking whether the
     * package on disk already satisfies it.
     *
     * The two questions are separate: the profile version says whether a
     * package is still *readable*, and the ladder says whether it is still
     * *complete*. Deciding completeness from the profile version alone means a
     * title that predates a new rung reports "nothing to do" — and moving the
     * profile version to force the issue is worse, because a mismatch resolves
     * the package to `missing` and withdraws a perfectly playable title from
     * delivery. So the ladder is compared directly. `decideProcessing` reads
     * only the values above, so asking it twice costs nothing.
     */
    const planned = decideProcessing(plan);
    const missingRungs = planned.ladder
      .map((rung) => rung.qualityHeight)
      .filter(
        (height) => !existing.present || !existing.rungs.includes(height),
      );
    const isCurrent =
      existing.present && existing.current && missingRungs.length === 0;

    /*
     * Re-decided once the outstanding work is known, so the estimate and the
     * disk preflight describe this job rather than the finished package. A
     * one-rung job otherwise reported the whole package's size as its own
     * output and reserved space for seven renditions it was not making.
     */
    const incremental =
      !isCurrent &&
      existing.present &&
      existing.current &&
      missingRungs.length > 0;
    const decision = isCurrent
      ? decideProcessing({ ...plan, alreadyCurrent: true })
      : incremental
        ? decideProcessing({
            ...plan,
            renditionsToEncode: missingRungs,
            // Existing audio is reused whenever the package is otherwise
            // current, so this run encodes none of it.
            audioTracksToEncode: 0,
          })
        : planned;

    return {
      decision,
      fingerprint,
      file,
      absolutePath,
      mtimeMs: stats.mtimeMs,
      existing: { ...existing, missingRungs },
    };
  }

  return [
    {
      method: "GET",
      path: "/processing/hardware",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, await hardware());
      },
    },

    {
      method: "GET",
      path: "/processing/overview",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        await store.reconcileTerminalQueueJobs();
        const [counts, report, jobs] = await Promise.all([
          store.counts(),
          hardware(),
          store.list({ limit: 50 }),
        ]);
        sendData(context.response, context.requestId, {
          counts,
          hardware: report,
          jobs: jobs.map(toJobDto),
          stages: PROCESSING_STAGES,
          profile: ADAPTIVE_PROFILE_VERSION,
        });
      },
    },

    {
      /** The decision, without queueing anything. */
      method: "POST",
      path: "/processing/preview",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;
        /*
         * A title whose source has been deleted still has a package worth
         * describing, so the preview reports the absent source rather than
         * failing on it. There is no decision to make without the bytes: the
         * page shows what is on disk and offers no way to start a job.
         */
        const located = await locateSource(itemId, mediaFileId);
        const stats = await statSource(located.file, located.absolutePath);
        if (!stats) {
          const existing = await existingPackage(located.absolutePath, null);
          const activeJob = await store.findActiveForFile(located.file.id);
          sendData(context.response, context.requestId, {
            itemId,
            mediaFileId: located.file.id,
            relativePath: located.file.relativePath,
            sourceAvailable: false,
            sourceFingerprint: null,
            decision: null,
            existing: { ...existing, missingRungs: [] },
            activeJobId: activeJob?.id ?? null,
          });
          return;
        }

        const { decision, file, fingerprint, existing } = await analyse(
          itemId,
          mediaFileId,
        );
        const active = await store.findActiveForFile(file.id);
        sendData(context.response, context.requestId, {
          itemId,
          mediaFileId: file.id,
          relativePath: file.relativePath,
          sourceAvailable: true,
          sourceFingerprint: fingerprint,
          decision,
          existing,
          activeJobId: active?.id ?? null,
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(8 * 1024), [
          "itemId",
          "mediaFileId",
        ]);
        const itemId = requireUuid(
          optionalBodyString(body, "itemId"),
          "itemId",
        );
        const mediaFileId = body.mediaFileId
          ? requireUuid(optionalBodyString(body, "mediaFileId"), "mediaFileId")
          : undefined;
        const { decision, file, fingerprint, absolutePath, mtimeMs, existing } =
          await analyse(itemId, mediaFileId);

        if (decision.action.startsWith("reject")) {
          throw new OwnApiError("PROCESSING_REJECTED", decision.summary, 422);
        }
        if (!decision.estimate.sufficient) {
          throw new OwnApiError(
            "INSUFFICIENT_DISK_SPACE",
            "There is not enough free space for this package and its staging copy.",
            507,
          );
        }

        let job: ProcessingJobRecord;
        try {
          job = await store.create({
            itemId,
            mediaFileId: file.id,
            sourceFingerprint: fingerprint,
            profile: ADAPTIVE_PROFILE_VERSION,
            /*
             * The job records the rungs it is actually going to build, not
             * only the ladder the finished package will hold. Without it a
             * one-rung job is indistinguishable from a full rebuild in the
             * history, which is exactly the confusion that hid this bug.
             */
            /*
             * `decision.renditionsToEncode` already states the work; the flag
             * only records whether this was an addition to a package that was
             * otherwise complete, which is what the history reads back.
             */
            decision: {
              ...decision,
              incremental:
                existing.present &&
                decision.renditionsToEncode.length > 0 &&
                decision.renditionsToEncode.length < decision.ladder.length,
            } as unknown as Record<string, unknown>,
            streamDecisions: {
              audio: decision.streams.audio,
              subtitles: decision.streams.subtitles,
            } as unknown as Record<string, unknown>,
            estimatedOutputBytes: decision.estimate.outputBytes,
            estimatedStagingBytes: decision.estimate.stagingBytes,
            hardwareAdapter: decision.hardwareAdapter,
            videoEncoder: decision.videoEncoder,
            warnings: decision.warnings,
          });
        } catch (error) {
          if (error instanceof DuplicateProcessingJobError) {
            throw new OwnApiError(
              "PROCESSING_JOB_EXISTS",
              "This file already has a processing job that has not finished.",
              409,
            );
          }
          throw error;
        }

        const queueJobId = await queue.enqueue({
          jobType: PROCESSING_JOB_TYPE,
          payload: {
            processingJobId: job.id,
            sourcePath: absolutePath,
            relativePath: file.relativePath,
            sizeBytes: Number(file.sizeBytes),
            mtimeMs,
          },
          dedupeKey: `processing:${file.id}`,
        });
        await store.attachQueueJob(job.id, queueJobId);
        await store.appendEvent({
          processingJobId: job.id,
          stage: "waiting",
          message: "Queued for processing.",
        });

        sendData(
          context.response,
          context.requestId,
          { job: toJobDto((await store.get(job.id))!) },
          202,
        );
      },
    },

    {
      method: "GET",
      path: "/processing/jobs",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        await store.reconcileTerminalQueueJobs();
        const stateParam = context.url.searchParams.get("state");
        const limit = parseLimit(
          context.url.searchParams.get("limit"),
          50,
          200,
        );
        const jobs = await store.list({
          ...(stateParam ? { state: stateParam as ProcessingState } : {}),
          limit,
        });
        sendData(context.response, context.requestId, jobs.map(toJobDto));
      },
    },

    {
      method: "GET",
      path: "/processing/jobs/:jobId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        const after = Number(
          context.url.searchParams.get("afterSequence") ?? 0,
        );
        sendData(context.response, context.requestId, {
          job: toJobDto(job),
          streamDecisions: job.streamDecisions,
          events: (
            await store.listEvents(id, Number.isFinite(after) ? after : 0)
          ).map((event) => ({
            sequence: event.sequence,
            stage: event.stage,
            level: event.level,
            message: event.message,
            createdAt: event.createdAt.toISOString(),
          })),
        });
      },
    },

    {
      method: "DELETE",
      path: "/processing/jobs/:jobId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        if (["pending", "queued", "running", "paused"].includes(job.state)) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "An active processing job cannot be removed from history.",
            409,
          );
        }
        const removed = await store.deleteFinished(id);
        if (!removed) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "An active processing job cannot be removed from history.",
            409,
          );
        }
        sendData(context.response, context.requestId, { removed: true });
      },
    },

    {
      /**
       * Live progress, as Server-Sent Events.
       *
       * SSE rather than a WebSocket: this is one-way, the server already speaks
       * HTTP with the same session cookie, and a dropped connection reconnects
       * on its own. Every event carries the job's own sequence number as the
       * SSE id, so a browser reconnecting with `Last-Event-ID` resumes exactly
       * where it stopped instead of replaying the timeline or skipping part of
       * it.
       */
      method: "GET",
      path: "/processing/jobs/:jobId/stream",
      access: "admin",
      skipCsrf: true,
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }

        const lastEventId = Number(
          context.request.headers["last-event-id"] ??
            context.url.searchParams.get("lastEventId") ??
            0,
        );
        let sequence =
          Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;

        const { response } = context;
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Connection", "keep-alive");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();

        let closed = false;
        const send = (event: string, data: unknown, eventId?: number) => {
          if (closed || response.writableEnded) return;
          const lines = [
            ...(eventId === undefined ? [] : [`id: ${eventId}`]),
            `event: ${event}`,
            `data: ${JSON.stringify(data)}`,
            "",
            "",
          ];
          response.write(lines.join("\n"));
        };

        const tick = async () => {
          if (closed) return;
          try {
            const current = await store.get(id);
            if (!current) {
              send("error", { message: "The job no longer exists." });
              finish();
              return;
            }
            send("progress", toJobDto(current));
            const events = await store.listEvents(id, sequence);
            for (const entry of events) {
              sequence = entry.sequence;
              send(
                "stage",
                {
                  sequence: entry.sequence,
                  stage: entry.stage,
                  level: entry.level,
                  message: entry.message,
                  createdAt: entry.createdAt.toISOString(),
                },
                entry.sequence,
              );
            }
            if (["succeeded", "failed", "cancelled"].includes(current.state)) {
              send("done", toJobDto(current));
              finish();
            }
          } catch {
            // A transient database error must not kill the stream; the next
            // tick tries again.
          }
        };

        const interval = setInterval(() => void tick(), 1000);
        // Keeps intermediaries from closing an idle connection between stages.
        const keepAlive = setInterval(() => {
          if (!closed && !response.writableEnded)
            response.write(": keep-alive\n\n");
        }, 15_000);

        function finish() {
          if (closed) return;
          closed = true;
          clearInterval(interval);
          clearInterval(keepAlive);
          response.end();
        }

        context.request.on("close", finish);
        await tick();

        // Held open until the client disconnects or the job finishes.
        await new Promise<void>((resolve) => {
          const settle = () => resolve();
          context.request.once("close", settle);
          const poll = setInterval(() => {
            if (closed) {
              clearInterval(poll);
              settle();
            }
          }, 500);
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/cancel",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        await store.requestCancellation(id);
        if (job.jobId) await queue.requestCancellation(job.jobId);
        await store.appendEvent({
          processingJobId: id,
          stage: job.stage,
          level: "warning",
          message: "Cancellation requested.",
        });
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    /**
     * Suspends an encode without losing it.
     *
     * Cancelling a two-hour 4K ladder throws away every frame it has produced.
     * Pausing stops the encoder where it stands and keeps the work, which is
     * what an operator actually wants when they need the machine back for a
     * while.
     */
    {
      method: "POST",
      path: "/processing/jobs/:jobId/pause",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        await store.requestPause(id, "operator");
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/resume",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        /*
         * A job the storage paused cannot be resumed by hand while the volume
         * is still missing: it would wake straight into the same I/O failure
         * and be marked failed, which is exactly the outcome the auto-pause
         * exists to prevent.
         */
        if (job.pausedReason === "storage-unavailable" && !storageAvailable()) {
          throw new OwnApiError(
            "PROCESSING_STORAGE_UNAVAILABLE",
            "The media volume is not available. This job resumes on its own once the volume is back.",
            409,
          );
        }
        await store.resume(id);
        sendData(context.response, context.requestId, {
          job: toJobDto((await store.get(id))!),
        });
      },
    },

    {
      method: "POST",
      path: "/processing/jobs/:jobId/retry",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.jobId, "jobId");
        const job = await store.get(id);
        if (!job) {
          throw new OwnApiError(
            "PROCESSING_JOB_NOT_FOUND",
            "The processing job could not be found.",
            404,
          );
        }
        if (["queued", "running", "pending"].includes(job.state)) {
          throw new OwnApiError(
            "PROCESSING_JOB_ACTIVE",
            "This job has not finished yet.",
            409,
          );
        }
        const { decision, file, absolutePath, fingerprint, mtimeMs, existing } =
          await analyse(job.itemId, job.mediaFileId);
        /*
         * The whole attempt is reset in one place, and the estimate is taken
         * from the decision made *now*. Resetting a handful of fields by hand
         * here is what left a retry showing the previous attempt's 89%, its
         * finish time and its far larger full-ladder estimate.
         */
        await store.beginAttempt(id, {
          estimatedOutputBytes: decision.estimate.outputBytes,
          estimatedStagingBytes: decision.estimate.stagingBytes,
          decision: {
            ...decision,
            incremental:
              existing.present &&
              decision.renditionsToEncode.length > 0 &&
              decision.renditionsToEncode.length < decision.ladder.length,
          } as unknown as Record<string, unknown>,
          streamDecisions: {
            audio: decision.streams.audio,
            subtitles: decision.streams.subtitles,
          } as unknown as Record<string, unknown>,
          hardwareAdapter: decision.hardwareAdapter,
          videoEncoder: decision.videoEncoder,
          warnings: decision.warnings,
        });
        const queueJobId = await queue.enqueue({
          jobType: PROCESSING_JOB_TYPE,
          payload: {
            processingJobId: id,
            sourcePath: absolutePath,
            relativePath: file.relativePath,
            sizeBytes: Number(file.sizeBytes),
            mtimeMs,
          },
          dedupeKey: `processing:${file.id}:retry:${Date.now()}`,
        });
        await store.attachQueueJob(id, queueJobId);
        await store.appendEvent({
          processingJobId: id,
          stage: "waiting",
          message: "Re-queued after a retry.",
          detail: { sourceFingerprint: fingerprint },
        });
        sendData(
          context.response,
          context.requestId,
          { job: toJobDto((await store.get(id))!) },
          202,
        );
      },
    },
  ];
}
