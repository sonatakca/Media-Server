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

  /** Resolves an item to a real file on disk, refusing anything outside the root. */
  async function resolveSource(itemId: string, mediaFileId?: string) {
    const files = await catalogue.listFilesForItem(itemId);
    const file = mediaFileId
      ? files.find((candidate) => candidate.id === mediaFileId)
      : files[0];
    if (!file || file.missingSince !== null) {
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

  async function analyse(
    itemId: string,
    mediaFileId?: string,
  ): Promise<{
    decision: ProcessingDecision;
    fingerprint: string;
    file: Awaited<ReturnType<typeof resolveSource>>["file"];
    absolutePath: string;
    mtimeMs: number;
  }> {
    const { file, absolutePath } = await resolveSource(itemId, mediaFileId);
    const stats = await stat(absolutePath);
    const probe = await probeMediaFile(absolutePath, ffprobePath);
    const report = await hardware();
    const freeBytes = await freeBytesOn(renditionRoot);
    const decision = decideProcessing({
      probe,
      container: path.extname(absolutePath).replace(".", ""),
      sizeBytes: stats.size,
      hardware: report,
      ...(freeBytes === undefined ? {} : { freeBytes }),
    });
    const fingerprint = await computeSourceFingerprint(absolutePath, stats);
    return {
      decision,
      fingerprint,
      file,
      absolutePath,
      mtimeMs: stats.mtimeMs,
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
        const { decision, file, fingerprint } = await analyse(
          itemId,
          mediaFileId,
        );
        const active = await store.findActiveForFile(file.id);
        sendData(context.response, context.requestId, {
          itemId,
          mediaFileId: file.id,
          relativePath: file.relativePath,
          sourceFingerprint: fingerprint,
          decision,
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
        const { decision, file, fingerprint, absolutePath, mtimeMs } =
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
            decision: decision as unknown as Record<string, unknown>,
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
        const { file, absolutePath, fingerprint, mtimeMs } = await analyse(
          job.itemId,
          job.mediaFileId,
        );
        await store.update(id, {
          state: "queued",
          stage: "waiting",
          stageProgress: 0,
          errorCode: null,
          errorMessage: null,
          // A retry starts from a clean slate; keeping the flag would cancel
          // the new attempt the moment it began.
          cancellationRequested: false,
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
