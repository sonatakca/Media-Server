import { OwnApiError } from "../ownApiHandler";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteContext, RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyBoolean,
  optionalBodyInteger,
  optionalBodyString,
  requireBodyInteger,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type {
  SyncplayPrincipal,
  SyncplayRuntime,
  SyncplayStreamSink,
} from "./syncplayRuntime";
import { groupNotFound } from "./syncplayRuntime";
import type { GroupCommand, ParticipantStatus } from "./syncplayState";

/**
 * Party Watch HTTP surface.
 *
 * Commands and readiness go over the ordinary authenticated, CSRF-protected
 * REST surface; the group's state comes back on a server-sent event stream.
 * A client is identified by the id it generated for itself (one per tab, kept
 * across reloads) and by the user its session belongs to — never by a token a
 * third party could replay.
 */

export interface SyncplayRoutesOptions {
  runtime: SyncplayRuntime;
  catalogue: Pick<CatalogueRepository, "canUserAccessItem">;
  /** How often an idle stream carries a `ping`, so both ends notice a dead one. */
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_POSITION_MS = 100 * 60 * 60 * 1_000;
const MAX_REPORTED_LATENCY_MS = 5_000;
const STATUSES: readonly ParticipantStatus[] = [
  "loading",
  "ready",
  "stalled",
  "away",
];

function principalOf(context: RouteContext): SyncplayPrincipal {
  const principal = context.requirePrincipal();
  return {
    userId: principal.userId,
    displayName: principal.displayName,
    isAdministrator: principal.isAdministrator,
  };
}

function requireClientId(value: unknown): string {
  return requireUuid(typeof value === "string" ? value : undefined, "clientId");
}

async function requireItemAccess(
  catalogue: SyncplayRoutesOptions["catalogue"],
  userId: string,
  itemId: string,
): Promise<void> {
  if (!(await catalogue.canUserAccessItem(userId, itemId))) {
    throw new OwnApiError(
      "ITEM_NOT_FOUND",
      "The requested item could not be found.",
      404,
    );
  }
}

function parseCommand(body: Record<string, unknown>): GroupCommand {
  const type = requireBodyString(body, "type", { maxLength: 16 });
  const position = () =>
    optionalBodyInteger(body, "positionMs", { min: 0, max: MAX_POSITION_MS });

  switch (type) {
    case "play":
      return { type: "play" };
    case "pause": {
      const positionMs = position();
      return positionMs === undefined
        ? { type: "pause" }
        : { type: "pause", positionMs };
    }
    case "seek": {
      const positionMs = position();
      if (positionMs === undefined)
        throw validationError("positionMs is required.");
      return { type: "seek", positionMs };
    }
    case "setItem": {
      const itemId = requireUuid(
        optionalBodyString(body, "itemId", { maxLength: 64 }),
        "itemId",
      );
      const fromItemId = optionalBodyString(body, "fromItemId", {
        maxLength: 64,
      });
      return {
        type: "setItem",
        itemId,
        fromItemId: fromItemId ? requireUuid(fromItemId, "fromItemId") : null,
      };
    }
    default:
      throw validationError("type is invalid.");
  }
}

export function createSyncplayRoutes({
  runtime,
  catalogue,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
}: SyncplayRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/syncplay/groups",
      access: "authenticated",
      handle: async (context) => {
        const principal = principalOf(context);
        const body = asObjectBody(await context.readJson(4 * 1_024), [
          "name",
          "itemId",
          "clientId",
          "positionMs",
          "playing",
        ]);
        const clientId = requireClientId(body.clientId);
        const rawItemId = optionalBodyString(body, "itemId", { maxLength: 64 });
        const itemId = rawItemId ? requireUuid(rawItemId, "itemId") : null;
        if (itemId)
          await requireItemAccess(catalogue, principal.userId, itemId);
        const name = optionalBodyString(body, "name", {
          maxLength: 120,
        })?.trim();
        const positionMs = optionalBodyInteger(body, "positionMs", {
          min: 0,
          max: MAX_POSITION_MS,
        });
        const playing = optionalBodyBoolean(body, "playing");

        const snapshot = await runtime.create({
          principal,
          clientId,
          itemId,
          ...(name ? { name } : {}),
          ...(positionMs === undefined
            ? {}
            : { start: { positionMs, playing: playing ?? false } }),
        });
        sendData(context.response, context.requestId, snapshot, 201);
      },
    },

    {
      method: "POST",
      path: "/syncplay/groups/:groupId/join",
      access: "authenticated",
      handle: async (context) => {
        const principal = principalOf(context);
        const groupId = requireUuid(context.params.groupId, "groupId");
        const body = asObjectBody(await context.readJson(1_024), ["clientId"]);
        const clientId = requireClientId(body.clientId);

        // Knowing a group's id is not enough: joining requires permission for
        // what it is watching. A group you may not see does not exist for you.
        const itemId = await runtime.itemIdOf(groupId);
        if (
          itemId &&
          !(await catalogue.canUserAccessItem(principal.userId, itemId))
        ) {
          throw groupNotFound();
        }

        sendData(
          context.response,
          context.requestId,
          await runtime.join({ groupId, principal, clientId }),
        );
      },
    },

    {
      method: "POST",
      path: "/syncplay/groups/:groupId/commands",
      access: "authenticated",
      handle: async (context) => {
        const principal = principalOf(context);
        const groupId = requireUuid(context.params.groupId, "groupId");
        const body = asObjectBody(await context.readJson(1_024), [
          "clientId",
          "sequence",
          "type",
          "positionMs",
          "itemId",
          "fromItemId",
        ]);
        const clientId = requireClientId(body.clientId);
        const sequence = requireBodyInteger(body, "sequence", {
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
        });
        const command = parseCommand(body);
        if (command.type === "setItem") {
          await requireItemAccess(catalogue, principal.userId, command.itemId);
        }

        sendData(
          context.response,
          context.requestId,
          await runtime.command({
            groupId,
            principal,
            clientId,
            sequence,
            command,
          }),
        );
      },
    },

    {
      /**
       * Readiness, and the keepalive. Doubling as the keepalive gives every
       * client a clock sample each time it proves it is alive.
       */
      method: "POST",
      path: "/syncplay/groups/:groupId/status",
      access: "authenticated",
      handle: async (context) => {
        const principal = principalOf(context);
        const groupId = requireUuid(context.params.groupId, "groupId");
        const body = asObjectBody(await context.readJson(1_024), [
          "clientId",
          "status",
          "revision",
          "latencyMs",
        ]);
        const clientId = requireClientId(body.clientId);
        const status = requireBodyString(body, "status", { maxLength: 16 });
        if (!STATUSES.includes(status as ParticipantStatus)) {
          throw validationError("status is invalid.");
        }
        const revision = requireBodyInteger(body, "revision", {
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        });
        const latencyMs = optionalBodyInteger(body, "latencyMs", {
          min: 0,
          max: MAX_REPORTED_LATENCY_MS,
        });

        sendData(
          context.response,
          context.requestId,
          await runtime.status({
            groupId,
            principal,
            clientId,
            report: {
              status: status as ParticipantStatus,
              revision,
              ...(latencyMs === undefined ? {} : { latencyMs }),
            },
          }),
        );
      },
    },

    {
      method: "POST",
      path: "/syncplay/groups/:groupId/leave",
      access: "authenticated",
      handle: async (context) => {
        const principal = principalOf(context);
        const groupId = requireUuid(context.params.groupId, "groupId");
        const body = asObjectBody(await context.readJson(1_024), ["clientId"]);
        await runtime.leave({
          groupId,
          principal,
          clientId: requireClientId(body.clientId),
        });
        sendNoContent(context.response);
      },
    },

    {
      method: "DELETE",
      path: "/syncplay/groups/:groupId",
      access: "authenticated",
      handle: async (context) => {
        const principal = principalOf(context);
        const groupId = requireUuid(context.params.groupId, "groupId");
        await runtime.close({ groupId, principal });
        sendNoContent(context.response);
      },
    },

    {
      /**
       * The group's state, as a server-sent event stream.
       *
       * Server-sent events rather than a WebSocket: the traffic that matters is
       * one-way (commands already have an authenticated, CSRF-protected REST
       * surface), it needs no new dependency or hand-rolled RFC 6455 framing,
       * and it passes proxies that refuse upgrade requests.
       *
       * Events: `snapshot` (the whole group state), `ping` (liveness and the
       * server clock), `closed` (the group is gone, with a reason) and
       * `superseded` (another connection took over this client).
       */
      method: "GET",
      path: "/syncplay/groups/:groupId/events",
      access: "authenticated",
      // An EventSource cannot set headers; the session cookie authorizes it and
      // the stream is read-only.
      skipCsrf: true,
      handle: async (context) => {
        const principal = principalOf(context);
        const groupId = requireUuid(context.params.groupId, "groupId");
        const clientId = requireClientId(
          context.url.searchParams.get("clientId"),
        );
        const { response } = context;

        let ended = false;
        let finish: () => void = () => undefined;
        const write = (event: string, data: unknown): void => {
          if (ended || response.writableEnded || response.destroyed) return;
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const end = (): void => {
          if (ended) return;
          ended = true;
          response.end();
          finish();
        };

        const sink: SyncplayStreamSink = {
          snapshot: (snapshot) => write("snapshot", snapshot),
          closed: (reason) => {
            write("closed", { reason });
            end();
          },
          superseded: () => {
            write("superseded", {});
            end();
          },
        };

        // Headers go out only once the runtime has accepted the stream, so a
        // client that is not a participant gets an ordinary 404 it can act on
        // rather than an open stream that never says anything.
        let stream: { close(): void } | null = null;
        const opened = runtime.openStream({
          groupId,
          principal,
          clientId,
          sink: {
            snapshot: (snapshot) => {
              if (!response.headersSent) {
                response.statusCode = 200;
                response.setHeader(
                  "Content-Type",
                  "text/event-stream; charset=utf-8",
                );
                response.setHeader("Cache-Control", "no-store");
                response.setHeader("Connection", "keep-alive");
                response.setHeader("X-Accel-Buffering", "no");
                response.flushHeaders?.();
                // Tells EventSource not to retry on its own too eagerly; the
                // client runs its own reconnect path and closes on error.
                response.write("retry: 5000\n\n");
              }
              sink.snapshot(snapshot);
            },
            closed: sink.closed,
            superseded: sink.superseded,
          },
        });
        stream = await opened;

        const heartbeat = setInterval(() => {
          write("ping", { serverTimeMs: Date.now() });
        }, heartbeatIntervalMs);
        heartbeat.unref();

        await new Promise<void>((resolve) => {
          finish = () => {
            clearInterval(heartbeat);
            stream?.close();
            stream = null;
            resolve();
          };
          if (ended) finish();
          // The response, not the request: a GET's request side completes as
          // soon as its (empty) body has been read.
          response.on("close", () => {
            ended = true;
            finish();
          });
          response.on("error", () => {
            ended = true;
            finish();
          });
        });
      },
    },
  ];
}
