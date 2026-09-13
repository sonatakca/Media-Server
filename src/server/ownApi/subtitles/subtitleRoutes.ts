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
import {
  parseSessionMaterial,
  type ProviderSessionVault,
} from "./providerSessionVault";
import type { SubtitleProvider } from "./subtitleProvider";
import { OwnApiError } from "../ownApiHandler";
import { readBinaryBody } from "../api/http";
import { normalizeLanguage } from "../../../renditions/processing/languages";
import { MAX_SUBTITLE_BYTES } from "./subtitlePayload";
import type { SubtitleUploader } from "./subtitleUpload";

/** The providers this deployment asks, and where their sign-ins are kept. */
export interface SubtitleSessionRoutesOptions {
  readonly providers: readonly Pick<
    SubtitleProvider,
    "id" | "label" | "requiresSession" | "languages"
  >[];
  readonly vault: ProviderSessionVault;
}

function parsePolicy(body: Record<string, unknown>) {
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
  return want;
}

/**
 * The languages an uploaded subtitle may be filed under.
 *
 * The player only ever offers English and Turkish tracks, so accepting a third
 * would file a subtitle correctly and then never show it — a worse answer than
 * a refusal that says so.
 */
const UPLOADABLE_LANGUAGES = new Set(["eng", "tur"]);

export function createSubtitleRoutes(
  repository: SubtitleRepository,
  queue: JobQueue,
  sessions?: SubtitleSessionRoutesOptions,
  uploader?: SubtitleUploader,
): RouteDefinition[] {
  const uploadRoutes: RouteDefinition[] = uploader
    ? [
        {
          /**
           * A subtitle somebody already has, filed and named by this system.
           *
           * The bytes arrive as the request body and the policy in the query,
           * which is the same shape the custom-artwork upload uses. A caller
           * never names a path: the destination is derived from the media file
           * the item resolves to, exactly as it is for a downloaded one.
           */
          method: "POST",
          path: "/subtitles/items/:itemId/upload",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const itemId = requireUuid(context.params.itemId, "itemId");
            const language = normalizeLanguage(
              context.url.searchParams.get("language") ?? "",
            );
            if (!UPLOADABLE_LANGUAGES.has(language))
              throw validationError(
                "Subtitles can be uploaded as Turkish or English.",
              );
            const flag = (name: string) =>
              context.url.searchParams.get(name) === "true";
            const bytes = await readBinaryBody(
              context.request,
              MAX_SUBTITLE_BYTES,
            );
            const result = await uploader.upload({
              itemId,
              language,
              forced: flag("forced"),
              hearingImpaired: flag("hearingImpaired"),
              replace: flag("replace"),
              bytes,
            });
            if (result.outcome === "error")
              throw new OwnApiError(
                "SUBTITLE_UPLOAD_REFUSED",
                result.reason,
                409,
              );
            sendData(context.response, context.requestId, result);
          },
        },
      ]
    : [];
  const sessionRoutes: RouteDefinition[] = sessions
    ? [
        {
          /** Which providers are asked, and whether each can be right now. Never material. */
          method: "GET",
          path: "/subtitles/providers",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            sendData(context.response, context.requestId, {
              providers: await Promise.all(
                sessions.providers.map(async (provider) => ({
                  id: provider.id,
                  label: provider.label,
                  languages: provider.languages,
                  requiresSession: provider.requiresSession,
                  session: provider.requiresSession
                    ? await sessions.vault.status(provider.id)
                    : null,
                })),
              ),
            });
          },
        },
        {
          /**
           * A person hands over the session their browser earned. Stored sealed,
           * never echoed; every attempt that was waiting for it is resumed.
           */
          method: "PUT",
          path: "/subtitles/providers/:providerId/session",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const provider = sessions.providers.find(
              (entry) =>
                entry.id === context.params.providerId && entry.requiresSession,
            );
            if (!provider)
              throw new OwnApiError("NOT_FOUND", "No such provider.", 404);
            const body = asObjectBody(await context.readJson(), [
              "cookie",
              "userAgent",
            ]);
            let material;
            try {
              material = parseSessionMaterial({
                cookie: body.cookie,
                userAgent: body.userAgent,
              });
            } catch (error) {
              throw validationError(
                error instanceof Error ? error.message : "Invalid session.",
              );
            }
            await sessions.vault.store(provider.id, material);
            const waiting = await repository.attemptsAwaiting(provider.id);
            for (const attemptId of waiting)
              await queue.enqueue({
                jobType: SUBTITLE_JOB_TYPES.resume,
                payload: { attemptId },
                dedupeKey: `subtitle:${attemptId}`,
              });
            sendData(context.response, context.requestId, {
              session: await sessions.vault.status(provider.id),
              resumed: waiting.length,
            });
          },
        },
        {
          method: "DELETE",
          path: "/subtitles/providers/:providerId/session",
          access: "admin",
          handle: async (context) => {
            context.requirePrincipal();
            const provider = sessions.providers.find(
              (entry) =>
                entry.id === context.params.providerId && entry.requiresSession,
            );
            if (!provider)
              throw new OwnApiError("NOT_FOUND", "No such provider.", 404);
            await sessions.vault.clear(provider.id);
            sendData(context.response, context.requestId, {
              session: await sessions.vault.status(provider.id),
            });
          },
        },
      ]
    : [];
  return [
    ...sessionRoutes,
    ...uploadRoutes,
    {
      /**
       * Subtitles for a whole title: the film, or every episode of a show or
       * season that has a file. A file already being searched for is not asked
       * twice.
       */
      method: "POST",
      path: "/subtitles/items/:itemId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const itemId = requireUuid(context.params.itemId, "itemId");
        const body = asObjectBody(await context.readJson(), [
          "language",
          "forced",
          "hearingImpaired",
          "replace",
        ]);
        const want = parsePolicy(body);
        const files = await repository.titleMediaFiles(itemId);
        let queued = 0;
        for (const mediaFileId of files) {
          const saved = await repository.ensureWant(mediaFileId, want);
          if (await repository.openAttempt(saved.id)) continue;
          const attempt = await repository.beginAttempt(saved.id);
          await queue.enqueue({
            jobType: SUBTITLE_JOB_TYPES.run,
            payload: { attemptId: attempt.id, replace: body.replace === true },
            dedupeKey: `subtitle:${attempt.id}`,
          });
          queued += 1;
        }
        sendData(context.response, context.requestId, {
          files: files.length,
          queued,
        });
      },
    },
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
      /**
       * What the subtitle system is doing, for an operator.
       *
       * Carries no provider session, no cookie and no candidate URL: the
       * provider abstraction holds those, and an attempt is identified to a
       * client by its own id and nothing else.
       */
      method: "GET",
      path: "/subtitles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const attempts = await repository.recentAttempts();
        sendData(context.response, context.requestId, {
          attempts: attempts.map((attempt) => ({
            attemptId: attempt.id,
            mediaFileId: attempt.mediaFileId,
            language: attempt.language,
            forced: attempt.forced,
            hearingImpaired: attempt.hearingImpaired,
            state: attempt.state,
            attempt: attempt.attempt,
            providerId: attempt.providerId,
            score: attempt.score,
            failureClass: attempt.failureClass,
            awaitingProviderId: attempt.awaitingProviderId,
            title: attempt.title,
            seasonNumber: attempt.seasonNumber,
            episodeNumber: attempt.episodeNumber,
          })),
        });
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
