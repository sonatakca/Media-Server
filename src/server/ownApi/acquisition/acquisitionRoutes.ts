/**
 * Acquisitions over HTTP.
 *
 * A caller names a target and a release the search already returned — never a
 * URL. The URL that fetches an NZB carries the provider's key, and an endpoint
 * that accepted one would be an endpoint that fetches anything a client asks
 * for, on the server's network, with the server's credentials.
 */
import { OwnApiError } from "../ownApiHandler";
import { sendAccepted, sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  optionalBodyString,
  parseLimit,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { JobQueue } from "../tasks/jobQueue";
import { ACQUISITION_JOB_TYPES } from "./acquisitionJobs";
import type {
  AcquisitionRepository,
  AcquisitionSummary,
} from "./acquisitionRepository";
import type { AcquisitionService } from "./acquisitionService";
import type { IndexerRegistry } from "../indexers/indexerRegistry";
import type { SabnzbdClient } from "./sabnzbd";
import { SabError } from "./sabnzbd";

const CREATE_KEYS = [
  "kind",
  "title",
  "year",
  "season",
  "episode",
  "itemId",
  "indexerId",
  "releaseGuid",
  "releaseTitle",
  "profileId",
  "profileName",
  "score",
  "reasons",
] as const;

/**
 * One queued submission per acquisition.
 *
 * The queue collapses this onto a job that is queued or already running, so
 * asking twice cannot put the same release in front of two workers. It does
 * not collapse onto a finished job, which is what leaves a retry free to run.
 */
function submitDedupeKey(acquisitionId: string): string {
  return `acquisition.submit:${acquisitionId}`;
}

interface AcquisitionDto {
  readonly id: string;
  readonly state: string;
  readonly origin: string;
  readonly target: { kind: string; title: string };
  readonly indexerId: string;
  readonly releaseTitle: string;
  readonly attempt: number;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly sizeBytes?: number;
  /** Present once downloading has finished. Read by the import phase. */
  readonly downloadPath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The wire shape.
 *
 * Carries neither the release's download URL nor SABnzbd's job identifier: the
 * first is credential-bearing and the second is an internal handle a client
 * has no use for and could otherwise quote back at a cancellation.
 */
function toDto(summary: AcquisitionSummary): AcquisitionDto {
  return {
    id: summary.id,
    state: summary.state,
    origin: summary.origin,
    target: { kind: summary.targetKind, title: summary.targetTitle },
    indexerId: summary.indexerId,
    releaseTitle: summary.releaseTitle,
    attempt: summary.attempt,
    ...(summary.failureClass ? { failureClass: summary.failureClass } : {}),
    ...(summary.failureDetail ? { failureDetail: summary.failureDetail } : {}),
    ...(summary.sizeBytes === undefined
      ? {}
      : { sizeBytes: summary.sizeBytes }),
    ...(summary.downloadPath ? { downloadPath: summary.downloadPath } : {}),
    createdAt: new Date(summary.createdAtMs).toISOString(),
    updatedAt: new Date(summary.updatedAtMs).toISOString(),
  };
}

export interface CreateAcquisitionRoutesOptions {
  readonly repository: AcquisitionRepository;
  readonly service: AcquisitionService;
  readonly indexers: IndexerRegistry;
  readonly queue: JobQueue;
  readonly sab: SabnzbdClient;
}

export function createAcquisitionRoutes({
  repository,
  service,
  indexers,
  queue,
  sab,
}: CreateAcquisitionRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/acquisitions",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const limit = parseLimit(context.url.searchParams.get("limit"));
        sendData(context.response, context.requestId, {
          acquisitions: (await repository.list(limit)).map(toDto),
        });
      },
    },
    {
      method: "GET",
      path: "/acquisitions/:acquisitionId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.acquisitionId, "acquisitionId");
        const detail = await repository.detail(id);
        if (!detail) {
          throw new OwnApiError("NOT_FOUND", "No such acquisition.", 404);
        }
        sendData(context.response, context.requestId, {
          acquisition: toDto(detail.acquisition),
          // The audit trail: every state it passed through, and why.
          events: detail.events.map((event) => ({
            fromState: event.fromState,
            toState: event.toState,
            ...(event.failureClass ? { failureClass: event.failureClass } : {}),
            ...(event.detail ? { detail: event.detail } : {}),
            at: new Date(event.atMs).toISOString(),
          })),
        });
      },
    },
    {
      /** The handoff the import phase reads. Nothing here acts on it. */
      method: "GET",
      path: "/acquisitions/ready-for-import",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          ready: (await repository.listReadyForImport()).map(toDto),
        });
      },
    },
    {
      method: "POST",
      path: "/acquisitions",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), CREATE_KEYS);

        const kind = optionalBodyString(body, "kind") ?? "movie";
        if (kind !== "movie" && kind !== "season" && kind !== "episode") {
          throw validationError("The kind must be movie, season or episode.");
        }
        const title = requireBodyString(body, "title", {
          maxLength: 500,
        }).trim();
        if (!title) throw validationError("A title is required.");
        const indexerId = requireBodyString(body, "indexerId", {
          maxLength: 64,
        });
        // Only a configured indexer. A client cannot name somewhere else to
        // fetch from, which is the point of taking an id rather than a URL.
        if (!indexers.get(indexerId)) {
          throw validationError("That indexer is not configured.");
        }
        const releaseGuid = requireBodyString(body, "releaseGuid", {
          maxLength: 500,
        });
        const releaseTitle = requireBodyString(body, "releaseTitle", {
          maxLength: 500,
        });

        const itemId = optionalBodyString(body, "itemId", { maxLength: 64 });
        const season = optionalBodyInteger(body, "season", {
          min: 0,
          max: 10_000,
        });
        const episode = optionalBodyInteger(body, "episode", {
          min: 0,
          max: 10_000,
        });
        const year = optionalBodyInteger(body, "year", {
          min: 1870,
          max: 2200,
        });
        if (kind !== "movie" && season === undefined) {
          throw validationError("A television acquisition needs a season.");
        }

        const acquisition = await repository.create({
          target: {
            kind,
            title,
            ...(itemId ? { itemId } : {}),
            ...(year === undefined ? {} : { year }),
            ...(season === undefined ? {} : { season }),
            ...(episode === undefined ? {} : { episode }),
          },
          indexerId,
          releaseGuid,
          releaseTitle,
          origin: "manual",
          evidence: {
            ...(optionalBodyString(body, "profileId", { maxLength: 64 })
              ? { profileId: optionalBodyString(body, "profileId")! }
              : {}),
            profileName:
              optionalBodyString(body, "profileName", { maxLength: 200 }) ??
              "Chosen by hand",
            policySnapshot: {},
            releaseFacts: {},
            score:
              optionalBodyInteger(body, "score", {
                min: -1_000_000,
                max: 1_000_000,
              }) ?? 0,
            reasons: body.reasons ?? [],
            rejected: [],
          },
        });

        /*
         * The work happens on the durable queue, so it survives a restart of
         * whichever process happens to be serving this request. The key is the
         * acquisition itself: a double-clicked button queues one submission,
         * and the caller is handed the id of the job that already exists.
         */
        const taskId = await queue.enqueue({
          jobType: ACQUISITION_JOB_TYPES.submit,
          payload: { acquisitionId: acquisition.id },
          dedupeKey: submitDedupeKey(acquisition.id),
        });
        sendData(
          context.response,
          context.requestId,
          { acquisition: toDto(acquisition), taskId },
          202,
        );
      },
    },
    {
      method: "POST",
      path: "/acquisitions/:acquisitionId/cancel",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.acquisitionId, "acquisitionId");
        const existing = await repository.get(id);
        if (!existing) {
          throw new OwnApiError("NOT_FOUND", "No such acquisition.", 404);
        }
        try {
          // The service removes only the job this acquisition owns; a client
          // never names a SABnzbd identifier, so it cannot reach another one.
          await service.cancel(id);
        } catch (error) {
          throw new OwnApiError(
            "ACQUISITION_COMPLETED",
            error instanceof Error ? error.message : "It cannot be cancelled.",
            409,
          );
        }
        sendNoContent(context.response);
      },
    },
    {
      method: "POST",
      path: "/acquisitions/:acquisitionId/retry",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.acquisitionId, "acquisitionId");
        const existing = await repository.get(id);
        if (!existing) {
          throw new OwnApiError("NOT_FOUND", "No such acquisition.", 404);
        }
        if (existing.state !== "failed") {
          throw new OwnApiError(
            "ACQUISITION_NOT_RETRYABLE",
            `An acquisition in ${existing.state} cannot be retried.`,
            409,
          );
        }
        await repository.update(
          id,
          "failed",
          { state: "awaiting_retry", retryAfterMs: null },
          "Retried by hand.",
        );
        const taskId = await queue.enqueue({
          jobType: ACQUISITION_JOB_TYPES.submit,
          payload: { acquisitionId: id },
          dedupeKey: submitDedupeKey(id),
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },
    {
      /**
       * Whether the download client is reachable.
       *
       * Separate from the server's own readiness on purpose: a media server
       * whose downloader is down can still serve everything it already has,
       * and making playback depend on SABnzbd would be a worse outage than the
       * one it reports.
       */
      method: "GET",
      path: "/acquisitions/client/status",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        try {
          sendData(context.response, context.requestId, {
            reachable: true,
            version: await sab.version(),
          });
        } catch (error) {
          sendData(context.response, context.requestId, {
            reachable: false,
            reason: error instanceof SabError ? error.kind : "unavailable",
            detail:
              error instanceof Error ? error.message : "The client failed.",
          });
        }
      },
    },
  ];
}
