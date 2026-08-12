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
  libraries: LibraryRepository;
}

/** Only safe, client-actionable fields leave the process. */
function toTaskDto(job: JobRecord) {
  return {
    id: job.id,
    type: job.jobType,
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.safeError,
    result: job.result,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export function createTaskRoutes({
  queue,
  libraries,
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
        sendData(context.response, context.requestId, jobs.map(toTaskDto));
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
        sendData(context.response, context.requestId, toTaskDto(job));
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
