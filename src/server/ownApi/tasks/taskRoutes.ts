import type { ProcessingJobStore } from "../processing/jobStore";
import { episodeCode } from "../processing/processingProjection";
import {
  liveProgressIsFresh,
  readLiveProgress,
} from "../processing/liveProgress";
import {
  presentTask,
  safeTaskLabel,
  type TaskPresentation,
} from "../../../lib/notifications/taskPresentation";
import { OwnApiError } from "../ownApiHandler";
import { sendAccepted, sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyBoolean,
  parseLimit,
  parseOptionalEnum,
  requireUuid,
} from "../api/validation";
import type { JobQueue, JobRecord, JobStatus } from "./jobQueue";
import { JOB_TYPES } from "./jobHandlers";
import type { LibraryRepository } from "../libraries/libraryRepository";

const JOB_STATUSES: JobStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

export interface TaskRoutesOptions {
  queue: JobQueue;
  processingJobs?: Pick<ProcessingJobStore, "get">;
  libraries: LibraryRepository;
  resolveMediaLabel?: (
    userId: string,
    itemId: string,
  ) => Promise<MediaSubject | null>;
}

/**
 * The naming fields of one title, straight from the catalogue.
 *
 * Separate fields rather than one composed string: a name that trips the
 * allowlist would otherwise take the episode number down with it, and an
 * anonymous card is exactly the thing this endpoint exists to prevent.
 */
export interface MediaSubject {
  kind: "movie" | "episode" | string;
  title: string | null;
  seriesTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
}

/**
 * Names one title the way the processing queue names it: the show carries the
 * card, the code and episode name say which part of it.
 */
export function describeMediaSubject(
  media: MediaSubject,
): NonNullable<TaskPresentation["subject"]> {
  const title = safeTaskLabel(media.title);
  const series = safeTaskLabel(media.seriesTitle);
  const code =
    typeof media.seasonNumber === "number" &&
    Number.isSafeInteger(media.seasonNumber) &&
    media.seasonNumber >= 0
      ? episodeCode(
          media.seasonNumber,
          typeof media.episodeNumber === "number" &&
            Number.isSafeInteger(media.episodeNumber) &&
            media.episodeNumber >= 0
            ? media.episodeNumber
            : null,
        )
      : undefined;
  const isEpisode = media.kind === "episode" || series !== undefined || !!code;
  const label = isEpisode ? (series ?? title) : title;
  return {
    type: "media",
    ...(label ? { label } : {}),
    // Kept apart from the name so a card can wear the short form on its line
    // and the long one inside, and so one rejected field cannot take the
    // other down with it.
    ...(isEpisode && code ? { code } : {}),
    ...(isEpisode && title && title !== label ? { detail: title } : {}),
    ...(label || (isEpisode && code) ? {} : { unnamed: true }),
  };
}

/** Only safe, client-actionable fields leave the process. */
export async function toTaskDto(
  job: JobRecord,
  libraries: LibraryRepository,
  resolveMediaLabel?: (id: string) => Promise<MediaSubject | null>,
  processingJobs?: Pick<ProcessingJobStore, "get">,
) {
  const presentation = presentTask(
    job.jobType,
    job.status === "running" ? job.progressMessage : null,
    job.status === "succeeded" ? job.result : null,
  );
  let itemId = job.payload.itemId;
  if (
    job.jobType === "media.process" &&
    typeof job.payload.processingJobId === "string" &&
    processingJobs
  ) {
    const processing = await processingJobs.get(job.payload.processingJobId);
    /*
     * Which title this is never changes once the row exists, so naming is read
     * from any attempt. A queued job whose attempt has not been re-attached is
     * still that episode, and a card that cannot say which episode it is about
     * is indistinguishable from the eleven behind it.
     */
    if (processing) itemId = processing.itemId;
    // Figures are a different matter: never combine a historical queue attempt
    // with a newer processing run.
    if (processing?.jobId === job.id) {
      /*
       * The same sample the processing page draws from, so the two never
       * disagree about how far along an encode is. Read only for a job that is
       * actually running — for anything else there is no rate to describe.
       */
      const sample =
        processing.state === "running"
          ? await readLiveProgress(processing.id).catch(() => null)
          : null;
      const live = sample && liveProgressIsFresh(sample) ? sample : null;
      const encodedSeconds = Math.max(
        live?.encodedSeconds ?? 0,
        processing.encodedSeconds,
      );
      const totalSeconds =
        live?.sourceDurationSeconds ?? processing.sourceDurationSeconds;
      /*
       * The row is written at checkpoints; the sample arrives four times a
       * second. Reading the phase off the row is what left a card saying
       * "Starting media processing, progress not measurable yet" beside a page
       * showing the same job eighty-four per cent through its picture.
       */
      const stage = live?.stage ?? processing.stage;
      /*
       * Read from whichever source named the phase above, never mixed. The
       * sample's phase and the row's phase advance independently, and pairing
       * one's name with the other's fraction reports the position of the phase
       * that has just ended under the name of the one that just began.
       */
      const phaseFraction = live
        ? live.phaseFraction
        : processing.stageProgress;
      if (
        stage === "video" &&
        /*
         * A paused encoder is suspended where it stands, so its position is
         * still a fact about the file on disk — the figure that stops being
         * true is the *rate*, and that is guarded separately below. Dropping
         * the position along with the rate is what left a suspended job saying
         * only "progress not measurable yet" beside a page showing it three
         * quarters encoded.
         */
        (processing.state === "running" || processing.state === "paused") &&
        Number.isFinite(encodedSeconds) &&
        encodedSeconds >= 0 &&
        totalSeconds !== null &&
        Number.isFinite(totalSeconds) &&
        totalSeconds > 0 &&
        encodedSeconds <= totalSeconds
      ) {
        presentation.encoding = {
          completedSeconds: encodedSeconds,
          totalSeconds,
        };
        /*
         * Only from a sample that is still arriving. A remaining time is a
         * statement about a rate that is happening now, and the last figure a
         * stopped encoder wrote stays true about the past while becoming a lie
         * about the future.
         */
        if (
          live &&
          typeof live.etaSeconds === "number" &&
          Number.isFinite(live.etaSeconds) &&
          live.etaSeconds >= 0 &&
          live.etaSeconds < 60 * 60 * 24 * 30
        )
          presentation.remainingSeconds = Math.round(live.etaSeconds);
      }
      if (
        [
          "analysing",
          "planning",
          "video",
          "audio",
          "subtitles",
          "packaging",
          "validating",
          "publishing",
        ].includes(stage)
      )
        presentation.stage = stage as typeof presentation.stage;
      /*
       * Assembling, verifying and publishing each measure themselves exactly,
       * and none of them is the picture — so without this a card went silent
       * for the whole last stretch of a job, saying "progress not measurable
       * yet" beside a page showing the package a hundred per cent assembled.
       */
      if (
        (processing.state === "running" || processing.state === "paused") &&
        typeof phaseFraction === "number" &&
        Number.isFinite(phaseFraction) &&
        phaseFraction >= 0 &&
        phaseFraction <= 1
      )
        presentation.phaseFraction = phaseFraction;
      /*
       * Pausing suspends the encoder; it does not end the queue attempt, so
       * the row this DTO is built from goes on saying `running` for as long as
       * the hold lasts. The processing job is the only thing that knows the
       * work has stopped, and why — a person's hand or an absent drive.
       */
      if (processing.state === "paused")
        presentation.outcome =
          processing.pausedReason === "storage-unavailable" ||
          processing.pausedReason === "storage-quarantined"
            ? "waiting-for-storage"
            : "paused";
      if (processing.sourceDamage?.length && processing.state === "succeeded")
        presentation.outcome = "damaged-output";
    }
  }
  const errors: Record<string, "deleted" | "provider" | "unavailable"> = {
    "The library no longer exists.": "deleted",
    "The item no longer exists.": "deleted",
    "No metadata provider is configured.": "provider",
    "Trickplay generation is not available.": "unavailable",
    "This server is not configured to process media.": "unavailable",
  };
  presentation.errorCode = errors[job.safeError ?? ""];
  if (typeof job.payload.libraryId === "string") {
    const library = await libraries.getById(job.payload.libraryId);
    presentation.subject = {
      type: "library",
      ...(library ? { label: safeTaskLabel(library.name) } : { deleted: true }),
    };
  }
  if (typeof itemId === "string" && resolveMediaLabel) {
    const media = await resolveMediaLabel(itemId as string);
    presentation.subject =
      media === null
        ? { type: "media", deleted: true }
        : describeMediaSubject(media);
  }
  return {
    id: job.id,
    type: job.jobType,
    status: job.status,
    progress: job.progress,
    presentation,
    progressMessage: null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.safeError
      ? "Task failed. Review task configuration and retry."
      : null,
    result: Object.fromEntries(
      (presentation.metrics ?? []).map(({ metric, value }) => [metric, value]),
    ),
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function createTaskRoutes({
  queue,
  processingJobs,
  libraries,
  resolveMediaLabel,
}: TaskRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/admin/libraries/:libraryId/scan",
      access: "admin",
      handle: async (context) => {
        const libraryId = requireUuid(context.params.libraryId, "libraryId");
        const library = await libraries.getById(libraryId);
        if (!library) {
          throw new OwnApiError(
            "LIBRARY_NOT_FOUND",
            "The requested library could not be found.",
            404,
          );
        }

        const body = asObjectBody(
          await context.readJson(2 * 1_024).catch(() => ({})),
          ["allowMassRemoval"],
        );

        const taskId = await queue.enqueue({
          jobType: JOB_TYPES.libraryScan,
          payload: {
            libraryId,
            allowMassRemoval:
              optionalBodyBoolean(body, "allowMassRemoval") === true,
          },
          // Repeated presses of "scan" collapse onto the in-flight scan for
          // this library instead of queueing duplicates.
          dedupeKey: `${JOB_TYPES.libraryScan}:${libraryId}`,
        });

        sendAccepted(context.response, context.requestId, taskId);
      },
    },

    {
      method: "POST",
      path: "/admin/libraries/scan-all",
      access: "admin",
      handle: async (context) => {
        const all = await libraries.listAll();
        const taskIds: string[] = [];
        for (const library of all) {
          taskIds.push(
            await queue.enqueue({
              jobType: JOB_TYPES.libraryScan,
              payload: { libraryId: library.id },
              dedupeKey: `${JOB_TYPES.libraryScan}:${library.id}`,
            }),
          );
        }
        sendData(context.response, context.requestId, { taskIds }, 202);
      },
    },

    {
      method: "GET",
      path: "/admin/tasks",
      access: "admin",
      handle: async (context) => {
        const limit = parseLimit(
          context.url.searchParams.get("limit"),
          200,
          50,
        );
        const status = parseOptionalEnum(
          context.url.searchParams.get("status"),
          JOB_STATUSES,
          "status",
        );
        const jobType = context.url.searchParams.get("type") ?? undefined;

        const jobs = await queue.list({
          limit,
          ...(status ? { status } : {}),
          ...(jobType ? { jobType } : {}),
        });
        sendData(
          context.response,
          context.requestId,
          await Promise.all(
            jobs.map((job) =>
              toTaskDto(
                job,
                libraries,
                resolveMediaLabel
                  ? (id) =>
                      resolveMediaLabel(context.requirePrincipal().userId, id)
                  : undefined,
                processingJobs,
              ),
            ),
          ),
        );
      },
    },

    {
      method: "GET",
      path: "/admin/tasks/:taskId",
      access: "admin",
      handle: async (context) => {
        const job = await queue.get(
          requireUuid(context.params.taskId, "taskId"),
        );
        if (!job) {
          throw new OwnApiError(
            "TASK_NOT_FOUND",
            "The requested task could not be found.",
            404,
          );
        }
        sendData(
          context.response,
          context.requestId,
          await toTaskDto(
            job,
            libraries,
            resolveMediaLabel
              ? (id) => resolveMediaLabel(context.requirePrincipal().userId, id)
              : undefined,
            processingJobs,
          ),
        );
      },
    },

    {
      method: "POST",
      path: "/admin/tasks/:taskId/cancel",
      access: "admin",
      handle: async (context) => {
        // Cancellation is cooperative: a running handler notices at its next
        // checkpoint. The response only reports that the request was recorded.
        await queue.requestCancellation(
          requireUuid(context.params.taskId, "taskId"),
        );
        sendNoContent(context.response);
      },
    },
  ];
}
