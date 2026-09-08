import type { MaintenancePhase } from "../../../lib/maintenance/maintenanceTasks";
import {
  DeferredJobError,
  PermanentJobError,
  type JobHandler,
} from "../tasks/worker";
import type { SubtitleRepository } from "./subtitleRepository";
import type { SubtitleService } from "./subtitleService";

export const SUBTITLE_JOB_TYPES = {
  run: "subtitle.run",
  reconcile: "subtitle.reconcile",
  resume: "subtitle.auth-resume",
} as const;

export function createSubtitleJobHandlers(
  service: SubtitleService,
  repository: SubtitleRepository,
): Record<string, JobHandler> {
  const execute =
    (resume: boolean): JobHandler =>
    async ({ job, reportProgress, isCancelled }) => {
      const id = job.payload.attemptId;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
        throw new PermanentJobError("The task must name a subtitle attempt.");
      if (!(await repository.getAttempt(id)))
        throw new PermanentJobError("The subtitle attempt no longer exists.");
      const phases: Record<string, MaintenancePhase> = {
        detecting: "reading",
        searching: "selecting",
        downloading: "reading",
        validating: "analysing",
        installing: "moving",
      };
      const result = await service.run(id, {
        resume,
        replace: job.payload.replace === true,
        isCancelled,
        progress: (event) =>
          reportProgress(0, `Subtitle ${event.phase}`, {
            phase: phases[event.phase]!,
            measure: {
              kind: "exact",
              completed: event.completed,
              total: event.total,
              unit:
                event.phase === "installing" || event.phase === "detecting"
                  ? "files"
                  : "items",
            },
          }),
      });
      if (result.state === "busy")
        throw new DeferredJobError(
          "Another subtitle operation owns this media file.",
          5_000,
        );
      return result;
    };
  return {
    [SUBTITLE_JOB_TYPES.run]: execute(false),
    [SUBTITLE_JOB_TYPES.resume]: execute(true),
    [SUBTITLE_JOB_TYPES.reconcile]: async ({ isCancelled, reportProgress }) => {
      const uncertain = await repository.uncertainAttempts();
      let examined = 0;
      for (const record of uncertain) {
        if (await isCancelled()) break;
        await service.run(record.id, { isCancelled });
        examined++;
        await reportProgress(0, "Reconciling subtitle attempts", {
          phase: "catalogue",
          measure: {
            kind: "exact",
            completed: examined,
            total: uncertain.length,
            unit: "items",
          },
        });
      }
      return { examined };
    },
  };
}
