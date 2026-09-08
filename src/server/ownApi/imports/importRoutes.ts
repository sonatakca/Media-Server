/**
 * Imports over HTTP.
 *
 * A caller names an acquisition, never a path. The importer's whole safety
 * argument is that both roots were authorised before any work began, and an
 * endpoint that accepted `{ from, to }` would hand that argument to whoever
 * sent the request — turning the service into a general-purpose file mover
 * running with the service account's rights.
 *
 * The source therefore comes from the completed download the acquisition
 * already recorded, resolved against the configured download root and refused
 * if it falls outside; the destination root comes from configuration. Neither
 * is anything a client can influence.
 */
import path from "node:path";
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
import { isPathInsideRoot } from "../../pathSecurity";
import { IMPORT_JOB_TYPES } from "./importJobs";
import type {
  ImportFileRecord,
  ImportRecord,
  ImportRepository,
} from "./importRepository";
import type { ImportService } from "./importService";

const CREATE_KEYS = [
  "acquisitionId",
  "kind",
  "title",
  "year",
  "season",
  "episode",
  "itemId",
  "isUpgrade",
] as const;

/** What the completed download and the library root are, for one target. */
export interface ImportSourceResolution {
  /** Absolute path SABnzbd reported for the finished download. */
  readonly downloadPath: string;
  readonly target: {
    readonly kind: "movie" | "season" | "episode";
    readonly title: string;
    readonly year?: number;
    readonly season?: number;
    readonly episode?: number;
    readonly itemId?: string;
  };
}

interface ImportDto {
  readonly id: string;
  readonly state: string;
  readonly strategy?: string;
  readonly target: { kind: string; title: string };
  readonly attempt: number;
  readonly isUpgrade: boolean;
  readonly failureClass?: string;
  readonly failureDetail?: string;
  readonly files: Array<{
    role: string;
    state: string;
    /** Library-relative. The absolute location is not a client's business. */
    destination?: string;
    sizeBytes?: number;
    failureClass?: string;
  }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The wire shape.
 *
 * Carries library-relative destinations and no absolute path at all — not the
 * download root, not the library root, not the source. Those name the layout
 * of the operator's disks, and a client has no use for them that is worth the
 * disclosure.
 */
function toDto(record: ImportRecord, files: ImportFileRecord[]): ImportDto {
  return {
    id: record.id,
    state: record.state,
    ...(record.strategy ? { strategy: record.strategy } : {}),
    target: { kind: record.targetKind, title: record.targetTitle },
    attempt: record.attempt,
    isUpgrade: record.isUpgrade,
    ...(record.failureClass ? { failureClass: record.failureClass } : {}),
    ...(record.failureDetail ? { failureDetail: record.failureDetail } : {}),
    files: files.map((file) => ({
      role: file.role,
      state: file.state,
      ...(file.destinationRelative
        ? { destination: file.destinationRelative }
        : {}),
      ...(file.sizeBytes === undefined ? {} : { sizeBytes: file.sizeBytes }),
      ...(file.failureClass ? { failureClass: file.failureClass } : {}),
    })),
    createdAt: new Date(record.createdAtMs).toISOString(),
    updatedAt: new Date(record.updatedAtMs).toISOString(),
  };
}

export interface CreateImportRoutesOptions {
  readonly repository: ImportRepository;
  readonly service: ImportService;
  readonly queue: JobQueue;
  /** The one directory an import may read a download out of. */
  readonly downloadRoot: string;
  /** Where the library for a target kind lives. */
  readonly libraryRootFor: (kind: string) => string | undefined;
  /** What the acquisition says it downloaded, and for what. */
  readonly resolveAcquisition: (
    acquisitionId: string,
  ) => Promise<ImportSourceResolution | null>;
}

export function createImportRoutes({
  repository,
  service,
  queue,
  downloadRoot,
  libraryRootFor,
  resolveAcquisition,
}: CreateImportRoutesOptions): RouteDefinition[] {
  const dedupeKey = (importId: string): string => `import.run:${importId}`;

  async function detailOf(id: string): Promise<ImportDto> {
    const detail = await repository.detail(id);
    if (!detail) throw new OwnApiError("NOT_FOUND", "No such import.", 404);
    return toDto(detail.record, detail.files);
  }

  return [
    {
      method: "GET",
      path: "/imports",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const limit = parseLimit(context.url.searchParams.get("limit"));
        const records = await repository.list(limit);
        const withFiles = await Promise.all(
          records.map(async (record) =>
            toDto(record, await repository.listFiles(record.id)),
          ),
        );
        sendData(context.response, context.requestId, { imports: withFiles });
      },
    },
    {
      /** What a person has to look at. The queue will not clear these alone. */
      method: "GET",
      path: "/imports/needs-attention",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const records = (await repository.list(200)).filter(
          (record) => record.state === "needs_attention",
        );
        const withFiles = await Promise.all(
          records.map(async (record) =>
            toDto(record, await repository.listFiles(record.id)),
          ),
        );
        sendData(context.response, context.requestId, { imports: withFiles });
      },
    },
    {
      method: "GET",
      path: "/imports/:importId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.importId, "importId");
        const detail = await repository.detail(id);
        if (!detail) throw new OwnApiError("NOT_FOUND", "No such import.", 404);
        sendData(context.response, context.requestId, {
          import: toDto(detail.record, detail.files),
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
      method: "POST",
      path: "/imports",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), CREATE_KEYS);
        const acquisitionId = requireUuid(
          requireBodyString(body, "acquisitionId", { maxLength: 64 }),
          "acquisitionId",
        );

        const resolved = await resolveAcquisition(acquisitionId);
        if (!resolved) {
          throw validationError(
            "That acquisition has no finished download to import.",
          );
        }

        /*
         * The download path came from SABnzbd, not from the caller, and it is
         * still checked: a download client writing outside the root Seyirlik
         * authorised is a misconfiguration, and following it would put the
         * importer somewhere nobody agreed to.
         */
        const absolute = path.resolve(resolved.downloadPath);
        if (!isPathInsideRoot(path.resolve(downloadRoot), absolute)) {
          throw validationError(
            "The finished download is outside the configured download root.",
          );
        }
        const sourceRelative = path
          .relative(path.resolve(downloadRoot), absolute)
          .split(path.sep)
          .join("/");

        const kind =
          optionalBodyString(body, "kind") ?? resolved.target.kind ?? "movie";
        if (kind !== "movie" && kind !== "season" && kind !== "episode") {
          throw validationError("The kind must be movie, season or episode.");
        }
        const libraryRoot = libraryRootFor(kind);
        if (!libraryRoot) {
          throw validationError(
            "No library is configured for that kind of media.",
          );
        }

        const title = (
          optionalBodyString(body, "title", { maxLength: 500 }) ??
          resolved.target.title
        ).trim();
        if (!title) throw validationError("A title is required.");

        const created = await repository.create({
          acquisitionId,
          target: {
            kind,
            title,
            ...(resolved.target.itemId
              ? { itemId: resolved.target.itemId }
              : {}),
            ...((optionalBodyInteger(body, "year", { min: 1870, max: 2200 }) ??
            resolved.target.year)
              ? {
                  year:
                    optionalBodyInteger(body, "year", {
                      min: 1870,
                      max: 2200,
                    }) ?? resolved.target.year,
                }
              : {}),
            ...((optionalBodyInteger(body, "season", { min: 0, max: 10_000 }) ??
            resolved.target.season)
              ? {
                  season:
                    optionalBodyInteger(body, "season", {
                      min: 0,
                      max: 10_000,
                    }) ?? resolved.target.season,
                }
              : {}),
            ...((optionalBodyInteger(body, "episode", {
              min: 0,
              max: 10_000,
            }) ?? resolved.target.episode)
              ? {
                  episode:
                    optionalBodyInteger(body, "episode", {
                      min: 0,
                      max: 10_000,
                    }) ?? resolved.target.episode,
                }
              : {}),
          },
          sourceRoot: path.resolve(downloadRoot),
          libraryRoot: path.resolve(libraryRoot),
          sourceRelative,
          isUpgrade: body.isUpgrade === true,
        });

        const taskId = await queue.enqueue({
          jobType: IMPORT_JOB_TYPES.run,
          payload: { importId: created.id },
          dedupeKey: dedupeKey(created.id),
        });
        sendData(
          context.response,
          context.requestId,
          { import: await detailOf(created.id), taskId },
          202,
        );
      },
    },
    {
      method: "POST",
      path: "/imports/:importId/retry",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.importId, "importId");
        const existing = await repository.get(id);
        if (!existing)
          throw new OwnApiError("NOT_FOUND", "No such import.", 404);
        /*
         * Only from a state a person can actually resolve. An import that is
         * `committing` may have changed the library already, and restarting it
         * by hand is exactly what reconciliation exists to prevent.
         */
        if (
          existing.state !== "failed" &&
          existing.state !== "needs_attention"
        ) {
          throw new OwnApiError(
            "IMPORT_NOT_RETRYABLE",
            `An import in ${existing.state} cannot be retried.`,
            409,
          );
        }
        await repository.update(
          id,
          existing.state,
          { state: "planned", retryAfterMs: null },
          "Retried by hand.",
        );
        const taskId = await queue.enqueue({
          jobType: IMPORT_JOB_TYPES.run,
          payload: { importId: id },
          dedupeKey: dedupeKey(id),
        });
        sendAccepted(context.response, context.requestId, taskId);
      },
    },
    {
      method: "POST",
      path: "/imports/:importId/cancel",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.importId, "importId");
        const existing = await repository.get(id);
        if (!existing)
          throw new OwnApiError("NOT_FOUND", "No such import.", 404);
        /*
         * Never from a state where the library may already have changed.
         * Cancelling a commit would leave a file in the library that no import
         * claims, which is the one thing reconciliation cannot resolve on its
         * own.
         */
        if (
          existing.state === "committing" ||
          existing.state === "uncertain" ||
          existing.state === "committed" ||
          existing.state === "cleaning" ||
          existing.state === "complete"
        ) {
          throw new OwnApiError(
            "IMPORT_NOT_CANCELLABLE",
            `An import in ${existing.state} cannot be cancelled.`,
            409,
          );
        }
        await repository.update(
          id,
          existing.state,
          { state: "cancelled" },
          "Cancelled by hand.",
        );
        sendNoContent(context.response);
      },
    },
    {
      /** What reconciliation would do, on demand rather than on the timer. */
      method: "POST",
      path: "/imports/:importId/reconcile",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.importId, "importId");
        if (!(await repository.get(id))) {
          throw new OwnApiError("NOT_FOUND", "No such import.", 404);
        }
        const outcome = await service.reconcile(id);
        sendData(context.response, context.requestId, {
          import: await detailOf(id),
          outcome: { state: outcome.state, committed: outcome.committed },
        });
      },
    },
  ];
}
