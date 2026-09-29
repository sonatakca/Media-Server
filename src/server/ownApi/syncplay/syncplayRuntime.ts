import { randomUUID } from "node:crypto";
import { OwnApiError, type OwnApiLogger } from "../ownApiHandler";
import type { SyncplayRepository } from "./syncplayRepository";
import {
  applyCommand,
  createGroupState,
  isAdvancing,
  joinParticipant,
  participantKey,
  removeParticipant,
  reportStatus,
  setStreamOpen,
  SYNCPLAY_TUNING,
  tick,
  waitingFor,
  type GroupCommand,
  type GroupEvent,
  type GroupState,
  type HoldReason,
  type ParticipantPresence,
  type ParticipantStatus,
  type StatusReport,
  type SyncplayTuning,
  type Transition,
} from "./syncplayState";

/**
 * The live half of Party Watch: one in-memory owner per group.
 *
 * Every change to a group goes through `commit`, one at a time, which is what
 * makes the ordering question simple: the runtime applies a pure transition,
 * persists the timeline if it moved, and sends the complete resulting state to
 * every connected participant. Clients never have to reconstruct anything from
 * a sequence of messages; any snapshot is the whole truth as of its version.
 *
 * Groups are loaded on first use, so after a restart a group comes back the
 * moment its first participant reconnects, from the timeline in the database.
 * This is a single-process design: a second API process would need its own
 * owner for each group (or a shared broker), not a second copy of this map.
 */

export interface SyncplaySnapshotParticipant {
  /** Stable for the client's lifetime; `userId:clientId`. */
  id: string;
  userId: string;
  displayName: string;
  isOwner: boolean;
  presence: ParticipantPresence;
  status: ParticipantStatus;
}

export type SyncplayCauseKind =
  | GroupCommand["type"]
  | "joined"
  | "left"
  | "hold"
  | "resumed";

export interface SyncplayCause {
  kind: SyncplayCauseKind;
  participantId: string | null;
  /** Kept here because someone who has just left is no longer listed. */
  displayName: string | null;
  /** For "resumed": who the group stopped waiting for. */
  releasedPast?: Array<{ id: string; displayName: string }>;
  /** For "hold". */
  holdReason?: HoldReason;
}

export interface SyncplaySnapshot {
  id: string;
  name: string;
  ownerUserId: string;
  itemId: string | null;
  /** Changes when the server process does; orders snapshots with `version`. */
  epoch: string;
  version: number;
  revision: number;
  intent: "playing" | "paused";
  positionMs: number;
  /** Server time at which `positionMs` is true; may be slightly in the future. */
  anchorMs: number;
  serverTimeMs: number;
  hold: { reason: HoldReason; waitingFor: string[] } | null;
  participants: SyncplaySnapshotParticipant[];
  /** What produced this version, for the one-line notices clients show. */
  cause: SyncplayCause | null;
}

export type SyncplayCloseReason = "ended" | "empty" | "expired";

export interface SyncplayStreamSink {
  snapshot(snapshot: SyncplaySnapshot): void;
  closed(reason: SyncplayCloseReason): void;
  /** Another connection took over this participant. */
  superseded(): void;
}

export interface SyncplayPrincipal {
  userId: string;
  displayName: string;
  isAdministrator?: boolean;
}

export interface SyncplayRuntime {
  create(input: {
    principal: SyncplayPrincipal;
    clientId: string;
    itemId: string | null;
    name?: string;
    /**
     * Where the creator already is. A party starts from the creator's own
     * playback, so starting one never moves or pauses what they are watching.
     */
    start?: { positionMs: number; playing: boolean };
  }): Promise<SyncplaySnapshot>;
  join(input: {
    groupId: string;
    principal: SyncplayPrincipal;
    clientId: string;
  }): Promise<SyncplaySnapshot>;
  /** The group's current title, for access checks before joining. */
  itemIdOf(groupId: string): Promise<string | null>;
  leave(input: {
    groupId: string;
    principal: SyncplayPrincipal;
    clientId: string;
  }): Promise<void>;
  close(input: {
    groupId: string;
    principal: SyncplayPrincipal;
  }): Promise<void>;
  command(input: {
    groupId: string;
    principal: SyncplayPrincipal;
    clientId: string;
    sequence: number;
    command: GroupCommand;
  }): Promise<{
    accepted: boolean;
    snapshot: SyncplaySnapshot;
    /**
     * The highest sequence the group has taken from this client. A tab that
     * reloaded starts counting afresh; this tells it where to resume.
     */
    lastSequence: number;
  }>;
  status(input: {
    groupId: string;
    principal: SyncplayPrincipal;
    clientId: string;
    report: StatusReport;
  }): Promise<{ serverTimeMs: number }>;
  openStream(input: {
    groupId: string;
    principal: SyncplayPrincipal;
    clientId: string;
    sink: SyncplayStreamSink;
  }): Promise<{ close(): void }>;
  /** Runs the time-driven transitions once. The runtime's own timer calls it. */
  tickAll(): void;
  start(): void;
  stop(): void;
}

export interface SyncplayRuntimeOptions {
  repository: SyncplayRepository;
  logger?: OwnApiLogger;
  now?: () => number;
  tuning?: SyncplayTuning;
  /** How often hold deadlines and presence are re-evaluated. */
  tickIntervalMs?: number;
  /**
   * After a restart, how long a group stored as open waits for its first
   * participant to come back before it is closed for good.
   */
  rejoinWindowMs?: number;
}

interface LiveGroup {
  state: GroupState;
  version: number;
  cause: SyncplayCause | null;
  streams: Map<string, SyncplayStreamSink>;
  closed: boolean;
  persisting: Promise<void> | null;
  persistAgain: boolean;
}

export function groupNotFound(): OwnApiError {
  return new OwnApiError(
    "GROUP_NOT_FOUND",
    "The requested group could not be found.",
    404,
  );
}

export function participantNotFound(): OwnApiError {
  return new OwnApiError(
    "PARTICIPANT_NOT_FOUND",
    "This client is not part of the group. Join it again.",
    404,
  );
}

function causeFrom(
  events: GroupEvent[],
  nameOf: (participantKey: string) => string | null,
): SyncplayCause | null {
  const about = (participantId: string | null) => ({
    participantId,
    displayName: participantId ? nameOf(participantId) : null,
  });
  const command = events.find((event) => event.type === "command");
  if (command) {
    return { kind: command.command, ...about(command.participantKey) };
  }
  const released = events.find((event) => event.type === "hold-released");
  if (released) {
    return {
      kind: "resumed",
      ...about(null),
      releasedPast: released.releasedPast.map((id) => ({
        id,
        displayName: nameOf(id) ?? "",
      })),
    };
  }
  const held = events.find((event) => event.type === "hold-started");
  if (held) {
    return {
      kind: "hold",
      ...about(held.waitingFor[0] ?? null),
      holdReason: held.reason,
    };
  }
  const joined = events.find(
    (event) => event.type === "participant-joined" && !event.rejoined,
  );
  if (joined && joined.type === "participant-joined") {
    return { kind: "joined", ...about(joined.participantKey) };
  }
  const left = events.find((event) => event.type === "participant-left");
  if (left && left.type === "participant-left") {
    return { kind: "left", ...about(left.participantKey) };
  }
  return null;
}

export function createSyncplayRuntime({
  repository,
  logger,
  now = Date.now,
  tuning = SYNCPLAY_TUNING,
  tickIntervalMs = 1_000,
  rejoinWindowMs = 120_000,
}: SyncplayRuntimeOptions): SyncplayRuntime {
  const epoch = randomUUID();
  const groups = new Map<string, LiveGroup>();
  const loading = new Map<string, Promise<LiveGroup>>();
  /**
   * Groups closed by this process. The database write that closes a group is
   * asynchronous; without this, a request arriving in that gap would find the
   * row still open and bring the group back.
   */
  const closedIds = new Set<string>();
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setTimeout> | null = null;

  const log = (
    level: "info" | "warn" | "error",
    event: string,
    context: Record<string, unknown>,
  ) => {
    const target = level === "info" ? logger?.info : logger?.[level];
    target?.call(logger, `syncplay.${event}`, context);
  };

  function snapshotOf(group: LiveGroup): SyncplaySnapshot {
    const { state } = group;
    const { timeline } = state;
    const time = now();
    return {
      id: state.id,
      name: state.name,
      ownerUserId: state.ownerUserId,
      itemId: timeline.itemId,
      epoch,
      version: group.version,
      revision: timeline.revision,
      intent: timeline.intent,
      positionMs: Math.round(timeline.positionMs),
      anchorMs: timeline.anchorMs,
      serverTimeMs: time,
      hold: timeline.hold
        ? {
            reason: timeline.hold.reason,
            waitingFor: waitingFor(state).map((participant) => participant.key),
          }
        : null,
      participants: state.participants.map((participant) => ({
        id: participant.key,
        userId: participant.userId,
        displayName: participant.displayName,
        isOwner: participant.userId === state.ownerUserId,
        presence: participant.presence,
        status: participant.status,
      })),
      cause: group.cause,
    };
  }

  function logEvents(groupId: string, events: GroupEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "command":
          log("info", "command.applied", {
            groupId,
            command: event.command,
            participant: event.participantKey,
          });
          break;
        case "command-ignored":
          log("info", "command.ignored", {
            groupId,
            command: event.command,
            participant: event.participantKey,
            reason: event.reason,
          });
          break;
        case "hold-started":
          log("info", "hold.started", {
            groupId,
            reason: event.reason,
            waitingFor: event.waitingFor,
          });
          break;
        case "hold-released":
          log(
            event.releasedPast.length > 0 ? "warn" : "info",
            "hold.released",
            {
              groupId,
              reason: event.reason,
              waitedMs: event.waitedMs,
              releasedPast: event.releasedPast,
            },
          );
          break;
        case "participant-joined":
          log("info", "participant.joined", {
            groupId,
            participant: event.participantKey,
            rejoined: event.rejoined,
          });
          break;
        case "participant-left":
          log("info", "participant.left", {
            groupId,
            participant: event.participantKey,
            reason: event.reason,
          });
          break;
        case "participant-presence":
          // Reconnects are routine; only a participant going silent is worth
          // a line, since it explains a hold ending without them.
          if (event.presence === "unresponsive") {
            log("warn", "participant.unresponsive", {
              groupId,
              participant: event.participantKey,
            });
          }
          break;
        case "participant-status":
          // Readiness flips on every seek; logging each would bury the rest.
          break;
      }
    }
  }

  function persist(group: LiveGroup): void {
    if (group.persisting) {
      group.persistAgain = true;
      return;
    }
    const run = async (): Promise<void> => {
      do {
        group.persistAgain = false;
        const timeline = group.state.timeline;
        const id = group.state.id;
        try {
          await repository.saveTimeline(id, {
            revision: timeline.revision,
            itemId: timeline.itemId,
            // A hold is not stored: a group restored mid-hold comes back paused
            // at the held position, rather than playing past what nobody saw.
            isPlaying: isAdvancing(timeline),
            positionMs: timeline.positionMs,
            anchorMs: timeline.anchorMs,
          });
        } catch (error) {
          log("error", "persist.failed", {
            groupId: id,
            revision: timeline.revision,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } while (group.persistAgain && !group.closed);
      group.persisting = null;
    };
    group.persisting = run();
  }

  function broadcast(group: LiveGroup): void {
    const snapshot = snapshotOf(group);
    for (const sink of group.streams.values()) {
      try {
        sink.snapshot(snapshot);
      } catch {
        // A broken stream closes itself; it must not stop delivery to others.
      }
    }
  }

  function closeGroup(group: LiveGroup, reason: SyncplayCloseReason): void {
    if (group.closed) return;
    group.closed = true;
    groups.delete(group.state.id);
    closedIds.add(group.state.id);
    for (const sink of group.streams.values()) {
      try {
        sink.closed(reason);
      } catch {
        // Already gone.
      }
    }
    group.streams.clear();
    log("info", "group.closed", { groupId: group.state.id, reason });
    void repository.close(group.state.id).catch((error: unknown) => {
      log("error", "close.failed", {
        groupId: group.state.id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  function commit(group: LiveGroup, transition: Transition): void {
    const before = group.state.participants;
    group.state = transition.state;
    logEvents(group.state.id, transition.events);

    if (group.state.participants.length === 0) {
      closeGroup(group, "empty");
      return;
    }

    // A participant removed by the state machine must also lose its stream,
    // or it would keep receiving a group it is no longer part of.
    for (const [key, sink] of group.streams) {
      if (!group.state.participants.some((p) => p.key === key)) {
        group.streams.delete(key);
        try {
          sink.closed("expired");
        } catch {
          // Already gone.
        }
      }
    }

    if (transition.timelineChanged) persist(group);
    if (transition.timelineChanged || transition.participantsChanged) {
      group.version += 1;
      const nameOf = (key: string) =>
        (
          group.state.participants.find((p) => p.key === key) ??
          before.find((p) => p.key === key)
        )?.displayName ?? null;
      group.cause = causeFrom(transition.events, nameOf);
      broadcast(group);
    }
  }

  function live(record: {
    id: string;
    name: string;
    ownerUserId: string;
    itemId: string | null;
    revision: number;
    isPlaying: boolean;
    positionMs: number;
    positionUpdatedAt: number;
  }): LiveGroup {
    return {
      state: createGroupState({
        id: record.id,
        name: record.name,
        ownerUserId: record.ownerUserId,
        itemId: record.itemId,
        now: now(),
        revision: record.revision,
        intent: record.isPlaying ? "playing" : "paused",
        positionMs: record.positionMs,
        anchorMs: record.positionUpdatedAt,
      }),
      version: 0,
      cause: null,
      streams: new Map(),
      closed: false,
      persisting: null,
      persistAgain: false,
    };
  }

  async function load(groupId: string): Promise<LiveGroup> {
    const existing = groups.get(groupId);
    if (existing) return existing;
    if (closedIds.has(groupId)) throw groupNotFound();
    const pending = loading.get(groupId);
    if (pending) return pending;

    const promise = (async () => {
      const record = await repository.findOpen(groupId);
      if (!record) throw groupNotFound();
      // Another caller may have created it while this one was reading.
      const raced = groups.get(groupId);
      if (raced) return raced;
      const group = live(record);
      groups.set(groupId, group);
      log("info", "group.restored", {
        groupId,
        revision: record.revision,
        isPlaying: record.isPlaying,
      });
      return group;
    })();
    loading.set(groupId, promise);
    try {
      return await promise;
    } finally {
      loading.delete(groupId);
    }
  }

  function requireParticipant(
    group: LiveGroup,
    principal: SyncplayPrincipal,
    clientId: string,
  ): string {
    const key = participantKey(principal.userId, clientId);
    if (!group.state.participants.some((p) => p.key === key)) {
      throw participantNotFound();
    }
    return key;
  }

  async function openGroup(groupId: string): Promise<LiveGroup> {
    const group = await load(groupId);
    if (group.closed) throw groupNotFound();
    return group;
  }

  function tickAll(): void {
    const time = now();
    for (const group of [...groups.values()]) {
      commit(group, tick(group.state, time, tuning));
    }
  }

  return {
    create: async ({ principal, clientId, itemId, name, start }) => {
      const record = await repository.create({
        name: name ?? `${principal.displayName}'s party`,
        ownerUserId: principal.userId,
        itemId,
      });
      const group = live(
        start
          ? {
              ...record,
              revision: 1,
              isPlaying: start.playing,
              positionMs: Math.max(0, start.positionMs),
              positionUpdatedAt: now(),
            }
          : record,
      );
      if (start) persist(group);
      groups.set(record.id, group);
      log("info", "group.created", {
        groupId: record.id,
        itemId,
        owner: principal.userId,
      });
      commit(
        group,
        joinParticipant(
          group.state,
          {
            userId: principal.userId,
            clientId,
            displayName: principal.displayName,
          },
          now(),
          tuning,
        ),
      );
      return snapshotOf(group);
    },

    itemIdOf: async (groupId) =>
      (await openGroup(groupId)).state.timeline.itemId,

    join: async ({ groupId, principal, clientId }) => {
      const group = await openGroup(groupId);
      commit(
        group,
        joinParticipant(
          group.state,
          {
            userId: principal.userId,
            clientId,
            displayName: principal.displayName,
          },
          now(),
          tuning,
        ),
      );
      return snapshotOf(group);
    },

    leave: async ({ groupId, principal, clientId }) => {
      const group = groups.get(groupId);
      if (!group) return;
      const key = participantKey(principal.userId, clientId);
      const sink = group.streams.get(key);
      group.streams.delete(key);
      commit(group, removeParticipant(group.state, key, "left", now(), tuning));
      // Its own stream is told last, so the leaving tab is not handed a
      // snapshot of a group it has just left.
      try {
        sink?.closed("ended");
      } catch {
        // Already gone.
      }
    },

    close: async ({ groupId, principal }) => {
      const group = await openGroup(groupId);
      if (
        group.state.ownerUserId !== principal.userId &&
        !principal.isAdministrator
      ) {
        throw new OwnApiError(
          "FORBIDDEN",
          "Only the person who started the party can end it.",
          403,
        );
      }
      closeGroup(group, "ended");
    },

    command: async ({ groupId, principal, clientId, sequence, command }) => {
      const group = await openGroup(groupId);
      const key = requireParticipant(group, principal, clientId);
      const transition = applyCommand(
        group.state,
        key,
        sequence,
        command,
        now(),
        tuning,
      );
      const accepted = !transition.events.some(
        (event) => event.type === "command-ignored",
      );
      commit(group, transition);
      const lastSequence =
        group.state.participants.find((p) => p.key === key)?.lastCommandSeq ??
        0;
      return { accepted, snapshot: snapshotOf(group), lastSequence };
    },

    status: async ({ groupId, principal, clientId, report }) => {
      const group = await openGroup(groupId);
      const key = requireParticipant(group, principal, clientId);
      commit(group, reportStatus(group.state, key, report, now(), tuning));
      return { serverTimeMs: now() };
    },

    openStream: async ({ groupId, principal, clientId, sink }) => {
      const group = await openGroup(groupId);
      const key = requireParticipant(group, principal, clientId);

      const previous = group.streams.get(key);
      group.streams.set(key, sink);
      if (previous) {
        log("info", "participant.superseded", { groupId, participant: key });
        try {
          previous.superseded();
        } catch {
          // Already gone.
        }
      }

      commit(group, setStreamOpen(group.state, key, true, now(), tuning));
      // The opening stream gets the state even when nothing changed.
      sink.snapshot(snapshotOf(group));

      return {
        close: () => {
          if (group.streams.get(key) !== sink) return;
          group.streams.delete(key);
          if (group.closed) return;
          commit(group, setStreamOpen(group.state, key, false, now(), tuning));
        },
      };
    },

    tickAll,

    start: () => {
      if (tickTimer) return;
      tickTimer = setInterval(() => {
        try {
          tickAll();
        } catch (error) {
          log("error", "tick.failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }, tickIntervalMs);
      tickTimer.unref?.();

      // Groups stored as open from before a restart get one window to be
      // rejoined. Anything nobody came back for is closed for good.
      sweepTimer = setTimeout(() => {
        void repository
          .closeOpenExcept([...groups.keys()])
          .then((closed) => {
            if (closed.length > 0) {
              log("info", "group.swept", { closed: closed.length });
            }
          })
          .catch((error: unknown) => {
            log("error", "sweep.failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          });
      }, rejoinWindowMs);
      sweepTimer.unref?.();
    },

    stop: () => {
      if (tickTimer) clearInterval(tickTimer);
      if (sweepTimer) clearTimeout(sweepTimer);
      tickTimer = null;
      sweepTimer = null;
    },
  };
}
