import { OwnApiError } from "../ownApiHandler";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyBoolean,
  optionalBodyInteger,
  optionalBodyString,
  requireBodyInteger,
  requireUuid,
} from "../api/validation";
import type { CatalogueRepository } from "../catalogue/catalogueRepository";
import type { SyncplayEventBus } from "./eventBus";
import type { SyncplayGroup, SyncplayRepository } from "./syncplayRepository";
import {
  applyCommand,
  currentPositionMs,
  evaluateReadiness,
  type SyncplayCommand,
  type SyncplayMemberState,
} from "./syncplayState";

export interface SyncplayRoutesOptions {
  syncplay: SyncplayRepository;
  catalogue: CatalogueRepository;
  events: SyncplayEventBus;
}

const HEARTBEAT_INTERVAL_MS = 20_000;
const MAX_POSITION_MS = 100 * 60 * 60 * 1_000;

function groupNotFound(): OwnApiError {
  return new OwnApiError(
    "GROUP_NOT_FOUND",
    "The requested group could not be found.",
    404,
  );
}

function toGroupDto(
  group: SyncplayGroup,
  members: SyncplayMemberState[],
  now: number,
) {
  const readiness = evaluateReadiness(members, now);

  return {
    id: group.id,
    name: group.name,
    ownerUserId: group.ownerUserId,
    itemId: group.itemId,
    sequence: group.state.sequence,
    isPlaying: group.state.isPlaying,
    // Both the anchor and the extrapolated value are sent: a client that
    // trusts its own clock uses the anchor, one that does not uses the value.
    positionMs: currentPositionMs(group.state, now),
    anchor: {
      positionMs: group.state.positionMs,
      serverTimeMs: group.state.positionUpdatedAt,
    },
    serverTimeMs: now,
    isWaiting: readiness.shouldHold,
    waitingFor: readiness.waitingFor,
    members: members.map((member) => ({
      userId: member.userId,
      displayName: member.displayName,
      isReady: member.isReady,
      isBuffering: member.isBuffering,
      positionMs: member.lastPositionMs,
    })),
  };
}

export function createSyncplayRoutes({
  syncplay,
  catalogue,
  events,
}: SyncplayRoutesOptions): RouteDefinition[] {
  async function requireMembership(
    groupId: string,
    userId: string,
  ): Promise<SyncplayGroup> {
    const group = await syncplay.findById(groupId);
    if (!group) throw groupNotFound();

    // Group membership is the authorization boundary; a non-member must not be
    // able to read or drive someone else's session.
    if (!(await syncplay.isMember(groupId, userId))) throw groupNotFound();
    return group;
  }

  async function broadcastState(groupId: string): Promise<void> {
    const group = await syncplay.findById(groupId);
    if (!group) {
      events.publish({ type: "closed", groupId, data: {} });
      return;
    }
    const members = await syncplay.listMembers(groupId);
    events.publish({
      type: "state",
      groupId,
      data: toGroupDto(group, members, Date.now()),
    });
  }

  async function runCommand(
    groupId: string,
    userId: string,
    command: SyncplayCommand,
    sequence: number,
  ): Promise<{ accepted: boolean; group: SyncplayGroup }> {
    const group = await requireMembership(groupId, userId);
    const result = applyCommand(group.state, command, sequence, Date.now());

    if (!result.accepted) return { accepted: false, group };

    const updated = await syncplay.applyState(groupId, result.state);
    // A null here means another command won the race between the read and the
    // write; the caller is told its command was stale, same as a low sequence.
    if (!updated) return { accepted: false, group };

    await broadcastState(groupId);
    return { accepted: true, group: updated };
  }

  function commandRoute(
    path: string,
    build: (body: Record<string, unknown>) => SyncplayCommand,
  ): RouteDefinition {
    return {
      method: "POST",
      path,
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const groupId = requireUuid(context.params.groupId, "groupId");
        const body = asObjectBody(await context.readJson(2 * 1_024), [
          "positionMs",
          "sequence",
        ]);
        const sequence = requireBodyInteger(body, "sequence", {
          min: 1,
          max: Number.MAX_SAFE_INTEGER,
        });

        const result = await runCommand(
          groupId,
          principal.userId,
          build(body),
          sequence,
        );

        if (!result.accepted) {
          throw new OwnApiError(
            "COMMAND_STALE",
            "A newer command has already been applied.",
            409,
          );
        }

        sendData(
          context.response,
          context.requestId,
          toGroupDto(
            result.group,
            await syncplay.listMembers(groupId),
            Date.now(),
          ),
        );
      },
    };
  }

  return [
    {
      method: "GET",
      path: "/syncplay/groups",
      access: "authenticated",
      handle: async (context) => {
        const groups = await syncplay.listOpen();
        sendData(
          context.response,
          context.requestId,
          groups.map((group) => ({
            id: group.id,
            name: group.name,
            itemId: group.itemId,
            memberCount: group.memberCount,
            isPlaying: group.state.isPlaying,
          })),
        );
      },
    },

    {
      method: "POST",
      path: "/syncplay/groups",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const body = asObjectBody(await context.readJson(4 * 1_024), [
          "name",
          "itemId",
        ]);

        const itemId = optionalBodyString(body, "itemId", { maxLength: 64 });
        if (itemId) {
          requireUuid(itemId, "itemId");
          if (!(await catalogue.canUserAccessItem(principal.userId, itemId))) {
            throw new OwnApiError(
              "ITEM_NOT_FOUND",
              "The requested item could not be found.",
              404,
            );
          }
        }

        const group = await syncplay.create({
          name:
            optionalBodyString(body, "name", { maxLength: 120 }) ??
            `${principal.displayName}'s group`,
          ownerUserId: principal.userId,
          itemId: itemId ?? null,
          displayName: principal.displayName,
        });

        sendData(
          context.response,
          context.requestId,
          toGroupDto(group, await syncplay.listMembers(group.id), Date.now()),
          201,
        );
      },
    },

    {
      method: "GET",
      path: "/syncplay/groups/:groupId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const groupId = requireUuid(context.params.groupId, "groupId");
        const group = await requireMembership(groupId, principal.userId);

        sendData(
          context.response,
          context.requestId,
          toGroupDto(group, await syncplay.listMembers(groupId), Date.now()),
        );
      },
    },

    {
      method: "POST",
      path: "/syncplay/groups/:groupId/join",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const groupId = requireUuid(context.params.groupId, "groupId");

        const group = await syncplay.findById(groupId);
        if (!group) throw groupNotFound();

        // Joining requires permission for what the group is watching, not just
        // knowledge of the group id.
        if (
          group.itemId &&
          !(await catalogue.canUserAccessItem(principal.userId, group.itemId))
        ) {
          throw groupNotFound();
        }

        await syncplay.join(groupId, principal.userId, principal.displayName);
        await broadcastState(groupId);

        sendData(
          context.response,
          context.requestId,
          toGroupDto(group, await syncplay.listMembers(groupId), Date.now()),
        );
      },
    },

    {
      method: "POST",
      path: "/syncplay/groups/:groupId/leave",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const groupId = requireUuid(context.params.groupId, "groupId");

        await syncplay.leave(groupId, principal.userId);
        const remaining = await syncplay.listMembers(groupId);
        if (remaining.length === 0) {
          await syncplay.close(groupId);
          events.publish({ type: "closed", groupId, data: {} });
        } else {
          await broadcastState(groupId);
        }

        sendNoContent(context.response);
      },
    },

    {
      method: "DELETE",
      path: "/syncplay/groups/:groupId",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const groupId = requireUuid(context.params.groupId, "groupId");
        const group = await syncplay.findById(groupId);
        if (!group) throw groupNotFound();

        if (group.ownerUserId !== principal.userId && !principal.isAdministrator) {
          throw new OwnApiError(
            "FORBIDDEN",
            "Only the group owner can close it.",
            403,
          );
        }

        await syncplay.close(groupId);
        events.publish({ type: "closed", groupId, data: {} });
        sendNoContent(context.response);
      },
    },

    commandRoute("/syncplay/groups/:groupId/play", (body) => ({
      type: "play",
      ...(optionalBodyInteger(body, "positionMs", {
        min: 0,
        max: MAX_POSITION_MS,
      }) === undefined
        ? {}
        : {
            positionMs: optionalBodyInteger(body, "positionMs", {
              min: 0,
              max: MAX_POSITION_MS,
            }) as number,
          }),
    })),

    commandRoute("/syncplay/groups/:groupId/pause", (body) => ({
      type: "pause",
      positionMs: requireBodyInteger(body, "positionMs", {
        min: 0,
        max: MAX_POSITION_MS,
      }),
    })),

    commandRoute("/syncplay/groups/:groupId/seek", (body) => ({
      type: "seek",
      positionMs: requireBodyInteger(body, "positionMs", {
        min: 0,
        max: MAX_POSITION_MS,
      }),
    })),

    {
      method: "POST",
      path: "/syncplay/groups/:groupId/report",
      access: "authenticated",
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const groupId = requireUuid(context.params.groupId, "groupId");
        await requireMembership(groupId, principal.userId);

        const body = asObjectBody(await context.readJson(2 * 1_024), [
          "isReady",
          "isBuffering",
          "positionMs",
        ]);

        await syncplay.updateMember(groupId, principal.userId, {
          ...(optionalBodyBoolean(body, "isReady") === undefined
            ? {}
            : { isReady: optionalBodyBoolean(body, "isReady") as boolean }),
          ...(optionalBodyBoolean(body, "isBuffering") === undefined
            ? {}
            : {
                isBuffering: optionalBodyBoolean(body, "isBuffering") as boolean,
              }),
          ...(optionalBodyInteger(body, "positionMs", {
            min: 0,
            max: MAX_POSITION_MS,
          }) === undefined
            ? {}
            : {
                positionMs: optionalBodyInteger(body, "positionMs", {
                  min: 0,
                  max: MAX_POSITION_MS,
                }) as number,
              }),
        });

        // Readiness changes what the group should be doing, so everyone is told.
        await broadcastState(groupId);
        sendNoContent(context.response);
      },
    },

    {
      /**
       * Authoritative state stream.
       *
       * Server-sent events rather than a WebSocket: the traffic is one-way
       * (commands already have an authenticated, CSRF-protected REST surface),
       * it needs no new dependency or hand-rolled RFC 6455 framing, and it
       * survives proxies that refuse upgrade requests.
       */
      method: "GET",
      path: "/syncplay/groups/:groupId/events",
      access: "authenticated",
      // An EventSource cannot set headers; the session cookie authorizes it and
      // the stream is read-only.
      skipCsrf: true,
      handle: async (context) => {
        const principal = context.requirePrincipal();
        const groupId = requireUuid(context.params.groupId, "groupId");
        const group = await requireMembership(groupId, principal.userId);

        context.response.statusCode = 200;
        context.response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        context.response.setHeader("Cache-Control", "no-store");
        context.response.setHeader("Connection", "keep-alive");
        context.response.setHeader("X-Accel-Buffering", "no");
        context.response.flushHeaders?.();

        const write = (event: { type: string; data: unknown }): void => {
          context.response.write(
            `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
          );
        };

        write({
          type: "state",
          data: toGroupDto(
            group,
            await syncplay.listMembers(groupId),
            Date.now(),
          ),
        });

        const unsubscribe = events.subscribe(groupId, (event) => {
          write({ type: event.type, data: event.data });
        });

        // Keeps intermediaries from closing an idle connection, and lets the
        // client notice a dead server.
        const heartbeat = setInterval(() => {
          context.response.write(": heartbeat\n\n");
        }, HEARTBEAT_INTERVAL_MS);
        heartbeat.unref();

        await new Promise<void>((resolve) => {
          const finish = () => {
            clearInterval(heartbeat);
            unsubscribe();
            resolve();
          };
          context.request.on("close", finish);
          context.response.on("close", finish);
          context.response.on("error", finish);
        });
      },
    },
  ];
}
