/**
 * Acquisition work on the existing job queue.
 *
 * Deliberately not a second background system. The queue already has durable
 * leases, heartbeats and restart recovery, and an acquisition that survives a
 * service restart is exactly what those were built for.
 *
 * Two handlers only. One hands a chosen release to SABnzbd; the other brings
 * every active acquisition back into agreement with it. Everything else —
 * retries, fallbacks, completion — is a consequence of those two running
 * again, which is what makes the pair safe to re-run at any moment.
 */
import type { JobHandler } from "../tasks/worker";
import { PermanentJobError } from "../tasks/worker";
import type { AcquisitionService } from "./acquisitionService";
import type { AcquisitionRepository } from "./acquisitionRepository";
import {
  dispositionFor,
  planRetry,
  type FailureClass,
} from "./acquisitionState";

export const ACQUISITION_JOB_TYPES = {
  submit: "acquisition.submit",
  reconcile: "acquisition.reconcile",
} as const;

export function createAcquisitionJobHandlers(
  service: AcquisitionService,
  repository: AcquisitionRepository,
): Record<string, JobHandler> {
  const submit: JobHandler = async ({ job, reportProgress }) => {
    const acquisitionId = job.payload.acquisitionId;
    if (typeof acquisitionId !== "string") {
      throw new PermanentJobError("The task payload names no acquisition.");
    }
    await reportProgress(0, "Handing the release to the download client");
    await service.submit(acquisitionId);
    const after = await repository.get(acquisitionId);
    // A deleted acquisition is not a transient fault; retrying cannot make it
    // exist, and the job queue would otherwise keep trying.
    if (!after)
      throw new PermanentJobError("The acquisition no longer exists.");
    return {
      state: after.state,
      ...(after.externalId ? { externalId: after.externalId } : {}),
    };
  };

  const reconcile: JobHandler = async ({ reportProgress }) => {
    await reportProgress(0, "Reconciling downloads");
    const result = await service.reconcile();

    /*
     * Reconciliation only records what SABnzbd says. Deciding what to do about
     * a failure happens here, once, after the facts are in — so a row cannot
     * be retried by the reconciler and by a failure handler at the same time.
     */
    let retried = 0;
    let abandoned = 0;
    for (const record of await repository.list(200)) {
      if (record.state !== "failed" || !record.failureClass) continue;
      const failure = record.failureClass as FailureClass;
      if (dispositionFor(failure) === "terminal") continue;
      const plan = planRetry(failure, record.attempt);
      if (plan.action === "retry") {
        if (
          await repository.update(
            record.id,
            "failed",
            {
              state: "awaiting_retry",
              retryAfterMs: Date.now() + plan.delayMs,
            },
            plan.detail,
          )
        ) {
          retried += 1;
        }
      } else if (plan.action === "try-another-release") {
        /*
         * Left as it is, on purpose. Choosing the next candidate means running
         * a search and the decision engine again, which belongs to whoever
         * asks for it — automatically or by hand — and not to a reconciler
         * whose job is to observe.
         */
        abandoned += 1;
      }
    }
    return { ...result, retried, awaitingAlternative: abandoned };
  };

  return {
    [ACQUISITION_JOB_TYPES.submit]: submit,
    [ACQUISITION_JOB_TYPES.reconcile]: reconcile,
  };
}
