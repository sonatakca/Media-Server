import { OwnApiError } from "../ownApiHandler";
import { sendAccepted, sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyBoolean,
  requireUuid,
} from "../api/validation";
import type { JobQueue } from "../tasks/jobQueue";
import { NFO_JOB_TYPES } from "./nfoJobs";
import type { NfoService } from "./nfoService";

/**
 * Administrator-only NFO endpoints.
 *
 * Preview answers synchronously because it writes nothing and an operator is
 * looking at it; the two exports go through the job queue like every other
 * long-running catalogue operation, so a library of ten thousand episodes is
 * not held open on one HTTP connection.
 *
 * No response here carries an absolute path. A conflict is reported as the
 * export-root-relative path plus a reason, which is everything needed to go and
 * look at the file and nothing about how the server's disks are arranged.
 */

export interface NfoRoutesOptions {
  service: NfoService;
  queue: JobQueue;
}

function itemNotFound(): OwnApiError {
  return new OwnApiError(
    "ITEM_NOT_FOUND",
    "The requested item could not be found.",
    404,
  );
}

export function createNfoRoutes({
  service,
  queue,
}: NfoRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/admin/items/:itemId/nfo/preview",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const preview = await service.preview(itemId);
        if (!preview) throw itemNotFound();
        sendData(context.response, context.requestId, preview);
      },
    },

    {
      method: "POST",
      path: "/admin/items/:itemId/nfo/export",
      access: "admin",
      handle: async (context) => {
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(
          await context.readJson(2 * 1_024).catch(() => ({})),
          ["force"],
        );
        const force = optionalBodyBoolean(body, "force") === true;

        // Existence is checked before queueing so an operator sees 404 now
        // rather than a task that fails a minute later.
        if (!(await service.preview(itemId))) throw itemNotFound();

        const taskId = await queue.enqueue({
          jobType: NFO_JOB_TYPES.exportItem,
          payload: { itemId, force },
          // A forced export must not collapse onto a queued unforced one:
          // they do different things to a conflicting file.
          dedupeKey: `${NFO_JOB_TYPES.exportItem}:${itemId}:${force ? "force" : "safe"}`,
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },

    {
      method: "POST",
      path: "/admin/libraries/:libraryId/nfo/export",
      access: "admin",
      handle: async (context) => {
        const libraryId = requireUuid(context.params.libraryId, "libraryId");
        const body = asObjectBody(
          await context.readJson(2 * 1_024).catch(() => ({})),
          ["force"],
        );
        const force = optionalBodyBoolean(body, "force") === true;

        const taskId = await queue.enqueue({
          jobType: NFO_JOB_TYPES.exportLibrary,
          payload: { libraryId, force },
          dedupeKey: `${NFO_JOB_TYPES.exportLibrary}:${libraryId}:${force ? "force" : "safe"}`,
          priority: 400,
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },
  ];
}
