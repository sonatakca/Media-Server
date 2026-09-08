import type { RouteDefinition } from "../api/router";
import { sendAccepted, sendData } from "../api/envelope";
import {
  asObjectBody,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { JobQueue } from "../tasks/jobQueue";
import type { SubtitleRepository } from "./subtitleRepository";
import { normalizeWant } from "./subtitleState";
import { SUBTITLE_JOB_TYPES } from "./subtitleJobs";

export function createSubtitleRoutes(
  repository: SubtitleRepository,
  queue: JobQueue,
): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/subtitles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), [
          "mediaFileId",
          "language",
          "forced",
          "hearingImpaired",
          "replace",
        ]);
        const mediaFileId = requireUuid(
          requireBodyString(body, "mediaFileId", { maxLength: 64 }),
          "mediaFileId",
        );
        if (
          (body.forced !== undefined && typeof body.forced !== "boolean") ||
          (body.replace !== undefined && typeof body.replace !== "boolean") ||
          (body.hearingImpaired !== undefined &&
            !["prefer", "avoid", "indifferent"].includes(
              String(body.hearingImpaired),
            ))
        )
          throw validationError("Invalid subtitle policy.");
        const want = normalizeWant({
          language: requireBodyString(body, "language", { maxLength: 16 }),
          forced: body.forced === true,
          hearingImpaired: body.hearingImpaired as
            | "prefer"
            | "avoid"
            | "indifferent"
            | undefined,
        });
        if (want.language === "und")
          throw validationError("A known subtitle language is required.");
        const saved = await repository.ensureWant(mediaFileId, want);
        const attempt = await repository.beginAttempt(saved.id);
        const jobId = await queue.enqueue({
          jobType: SUBTITLE_JOB_TYPES.run,
          payload: { attemptId: attempt.id, replace: body.replace === true },
          dedupeKey: `subtitle:${attempt.id}`,
        });
        sendAccepted(context.response, context.requestId, jobId);
      },
    },
    {
      method: "GET",
      path: "/subtitles/:attemptId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const record = await repository.getAttempt(
          requireUuid(context.params.attemptId, "attemptId"),
        );
        if (!record)
          throw validationError("The subtitle attempt does not exist.");
        sendData(context.response, context.requestId, {
          attemptId: record.id,
          state: record.state,
          awaitingProviderId: record.awaitingProviderId,
          failureClass: record.failureClass,
        });
      },
    },
    {
      method: "POST",
      path: "/subtitles/:attemptId/resume",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.attemptId, "attemptId");
        const record = await repository.getAttempt(id);
        if (!record || record.state !== "needs-authentication")
          throw validationError(
            "This subtitle attempt is not waiting for authentication.",
          );
        const jobId = await queue.enqueue({
          jobType: SUBTITLE_JOB_TYPES.resume,
          payload: { attemptId: id },
          dedupeKey: `subtitle:${id}`,
        });
        sendAccepted(context.response, context.requestId, jobId);
      },
    },
  ];
}
