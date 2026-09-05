import type { JobHandler } from "../tasks/worker";
import { PermanentJobError } from "../tasks/worker";
import type { NfoService } from "./nfoService";

/**
 * Background handlers for the two NFO exports.
 *
 * They live here rather than in `jobHandlers.ts` so the feature can be wired in
 * or left out as one unit: when no service is configured, the handlers are not
 * registered and the job types simply do not exist.
 */

export const NFO_JOB_TYPES = {
  exportItem: "nfo.export.item",
  exportLibrary: "nfo.export.library",
} as const;

export function createNfoJobHandlers(
  service: NfoService,
): Record<string, JobHandler> {
  const exportItem: JobHandler = async ({ job, reportProgress }) => {
    const itemId = job.payload.itemId;
    if (typeof itemId !== "string") {
      throw new PermanentJobError("The task payload is missing an item.");
    }

    await reportProgress(0, "Writing NFO metadata");
    const summary = await service.exportItem(itemId, {
      force: job.payload.force === true,
    });
    // A deleted item is not a transient fault; retrying cannot make it exist.
    if (!summary) throw new PermanentJobError("The item no longer exists.");
    return { ...summary };
  };

  const exportLibrary: JobHandler = async ({
    job,
    reportProgress,
    isCancelled,
  }) => {
    const libraryId = job.payload.libraryId;
    if (typeof libraryId !== "string") {
      throw new PermanentJobError("The task payload is missing a library.");
    }

    const summary = await service.exportLibrary(libraryId, {
      force: job.payload.force === true,
      reportProgress: (fraction, message) => reportProgress(fraction, message),
      isCancelled,
    });
    if (!summary) throw new PermanentJobError("The library no longer exists.");
    return { ...summary };
  };

  return {
    [NFO_JOB_TYPES.exportItem]: exportItem,
    [NFO_JOB_TYPES.exportLibrary]: exportLibrary,
  };
}
