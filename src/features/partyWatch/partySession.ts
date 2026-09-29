import { createPartyClock, type PartyClock } from "./partyClock";
import { partyLog } from "./partyDiagnostics";
import {
  classifyPartyFailure,
  type PartyStream,
  type PartyTransport,
} from "./partyWatchApi";
import type {
  PartyCause,
  PartyCommand,
  PartyParticipantStatus,
  PartySnapshot,
} from "./partyWatchTypes";

/**
 * One tab's membership of one party: the connection, the ordering of what the
 * server says, and what this tab tells it.
 *
 * It knows nothing about video. The playback engine reads `getState()` and the
 * clock, and reports readiness back through `setStatus`; the UI reads the same
 * state. Keeping the network here and the player there is what lets each be
 * reasoned about — and tested — on its own.
 *
 * Connection lifecycle, the only one there is:
 *
 *   joining ──join ok──▶ live ◀──join ok── reconnecting ◀─┐
 *      │                   │  stream error / silence      │
 *      │                   └──────────────────────────────┘
 *      └─ not found / signed out / left / ended ──▶ ended
 *
 * Every (re)connection is the same two steps: join (idempotent, re-registers
 * this client) and open the stream. A refresh, a dropped network, a server
 * restart and a superseded tab all recover through that one path.
 */

export type PartyConnection = "joining" | "live" | "reconnecting" | "ended";

export type PartyEndReason =
  /** The group does not exist, or this user may not see what it is watching. */
  | "not-found"
  /** Its owner ended it, or everyone else left. */
  | "ended"
  /** This tab left. */
  | "left"
  | "signed-out";

export interface PartyNotice {
  /** Increments per notice, so the same text twice still shows twice. */
  id: number;
  cause: PartyCause;
  snapshot: PartySnapshot;
}

export interface PartySessionState {
  groupId: string;
  clientId: string;
  selfId: string;
  connection: PartyConnection;
  endReason: PartyEndReason | null;
  snapshot: PartySnapshot | null;
  /** Commands sent and not yet answered. */
  pendingCommands: number;
  /** The last command did not reach the group. Cleared by the next that does. */
  commandFailed: boolean;
  /** Something another participant did, for a one-line notice. */
  notice: PartyNotice | null;
}

export type CommandOutcome = "applied" | "ignored" | "failed";

export interface PartySession {
  getState(): PartySessionState;
  subscribe(listener: () => void): () => void;
  readonly clock: PartyClock;
  start(): void;
  command(command: PartyCommand): Promise<CommandOutcome>;
  /** What this tab's player can do right now; sent when it changes. */
  setStatus(status: PartyParticipantStatus, revision: number): void;
  /** Leaves the party. Everyone else carries on. */
  leave(): Promise<void>;
  /** Ends the party for everyone. Owner only. */
  end(): Promise<void>;
}

/**
 * Why each timing is what it is. The server's matching values are in
 * `syncplayState.ts`; these must stay inside them.
 */
export const PARTY_SESSION_TUNING = {
  /** Keepalive, and a clock sample. The server presumes silence after 30 s. */
  keepaliveIntervalMs: 10_000,
  /**
   * The server pings every 15 s; a stream silent for this long is dead even if
   * the browser has not noticed — a half-open connection after a network
   * change can sit "open" for minutes.
   */
  streamSilenceLimitMs: 40_000,
  watchdogIntervalMs: 5_000,
  /**
   * A watchdog tick this late means the device slept: timers stopped, the
   * stream is almost certainly dead and the clock samples describe a time
   * before a possible clock correction.
   */
  sleepDetectionMs: 20_000,
  /** Reconnect backoff: first retry, and the ceiling it doubles towards. */
  reconnectInitialMs: 500,
  reconnectMaxMs: 10_000,
  /** A command unanswered this long has failed; the tab resyncs to the group. */
  commandTimeoutMs: 8_000,
} as const;

export interface PartySessionOptions {
  groupId: string;
  userId: string;
  clientId: string;
  transport: PartyTransport;
  /** A fresh id when another tab turns out to share this one's. */
  replaceClientId: () => string;
  /** The reply to creating the group, which already joined this client. */
  initialSnapshot?: PartySnapshot;
  now?: () => number;
  random?: () => number;
}

export function createPartySession({
  groupId,
  userId,
  clientId: initialClientId,
  transport,
  replaceClientId,
  initialSnapshot,
  now = Date.now,
  random = Math.random,
}: PartySessionOptions): PartySession {
  const tuning = PARTY_SESSION_TUNING;
  const clock = createPartyClock(now);
  const listeners = new Set<() => void>();

  let clientId = initialClientId;
  let state: PartySessionState = {
    groupId,
    clientId,
    selfId: `${userId}:${clientId}`,
    connection: "joining",
    endReason: null,
    snapshot: null,
    pendingCommands: 0,
    commandFailed: false,
    notice: null,
  };

  let started = false;
  let stream: PartyStream | null = null;
  /** Identifies the current connection attempt; stale callbacks compare it. */
  let connectionToken = 0;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastStreamActivityAt = now();
  let lastWatchdogAt = now();
  let firstSnapshotOnStream = true;
  const retiredEpochs = new Set<string>();
  let noticeCount = 0;

  // Sequences start at the wall clock so a reloaded tab, whose previous
  // incarnation used lower numbers, is still ahead of them; the server's reply
  // corrects the counter if this device's clock ran backwards.
  let sequence = now();
  let latestSequence = 0;

  let desiredStatus: { status: PartyParticipantStatus; revision: number } = {
    status: "loading",
    revision: 0,
  };
  let statusInFlight = false;
  let statusAgain = false;
  /** The server knows this client on the current connection. */
  let registered = false;

  const emit = (patch: Partial<PartySessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  const isEnded = () => state.connection === "ended";

  function accept(
    snapshot: PartySnapshot,
    { catchUp }: { catchUp: boolean },
  ): boolean {
    const current = state.snapshot;
    if (retiredEpochs.has(snapshot.epoch)) return false;
    if (
      current &&
      current.epoch === snapshot.epoch &&
      snapshot.version <= current.version
    ) {
      return false;
    }
    if (current && current.epoch !== snapshot.epoch) {
      retiredEpochs.add(current.epoch);
      partyLog("session.epoch-changed", { groupId, from: current.epoch });
    }

    const cause = snapshot.cause;
    const isNews =
      !catchUp &&
      cause !== null &&
      cause.participantId !== state.selfId &&
      // Someone else's command is news; so is a join, a leave, and a resume
      // without someone. A hold is not: it is shown for as long as it lasts.
      (cause.kind !== "resumed" || (cause.releasedPast?.length ?? 0) > 0) &&
      cause.kind !== "hold";

    emit({
      snapshot,
      ...(isNews && cause
        ? { notice: { id: (noticeCount += 1), cause, snapshot } }
        : {}),
    });
    return true;
  }

  function stopTimers(): void {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    if (watchdogTimer) clearInterval(watchdogTimer);
    reconnectTimer = null;
    keepaliveTimer = null;
    watchdogTimer = null;
  }

  function closeStream(): void {
    stream?.close();
    stream = null;
  }

  function finish(reason: PartyEndReason): void {
    if (isEnded()) return;
    connectionToken += 1;
    stopTimers();
    closeStream();
    detachWindowListeners();
    partyLog("session.ended", { groupId, reason });
    emit({ connection: "ended", endReason: reason });
  }

  function scheduleReconnect(why: string, immediate = false): void {
    if (isEnded()) return;
    connectionToken += 1;
    registered = false;
    closeStream();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const base = Math.min(
      tuning.reconnectMaxMs,
      tuning.reconnectInitialMs * 2 ** reconnectAttempts,
    );
    // Jitter, so a room full of clients does not reconnect in lockstep after
    // a server restart.
    const delay = immediate ? 0 : Math.round(base * (0.75 + random() * 0.5));
    reconnectAttempts += 1;
    partyLog("session.reconnect-scheduled", {
      groupId,
      why,
      attempt: reconnectAttempts,
      delayMs: delay,
    });
    if (state.connection !== "joining") emit({ connection: "reconnecting" });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  function handleFailure(error: unknown, during: string): void {
    const failure = classifyPartyFailure(error);
    partyLog("session.request-failed", { groupId, during, failure });
    switch (failure) {
      case "group-not-found":
        finish("not-found");
        return;
      case "forbidden":
        // Refused a title on joining means this party is not for this user.
        // Refused a single command (a title they cannot see) is only that.
        if (during === "join") finish("not-found");
        return;
      case "unauthorized":
        finish("signed-out");
        return;
      case "participant-not-found":
        // The server no longer has this tab (it restarted, or expired a tab
        // that was asleep). Joining again restores it.
        scheduleReconnect("participant-not-found", true);
        return;
      case "unreachable":
        // Nothing gets through, so the stream is not getting through either,
        // whatever the browser says about it: recover now rather than when the
        // silence watchdog eventually notices.
        if (state.connection !== "reconnecting" || during === "join") {
          scheduleReconnect(`${during}-unreachable`);
        }
        return;
      case "transient":
        if (during === "join" || during === "stream") {
          scheduleReconnect(during);
        }
    }
  }

  async function connect(): Promise<void> {
    if (isEnded()) return;
    const token = (connectionToken += 1);
    registered = false;
    closeStream();

    const sentAt = now();
    let snapshot: PartySnapshot;
    try {
      snapshot = await transport.join(groupId, clientId);
    } catch (error) {
      if (token === connectionToken) handleFailure(error, "join");
      return;
    }
    if (token !== connectionToken || isEnded()) return;
    clock.addSample({
      sentAt,
      receivedAt: now(),
      serverTimeMs: snapshot.serverTimeMs,
    });
    registered = true;
    accept(snapshot, { catchUp: true });
    // The server re-registered this client as loading; say where it really is.
    sendStatus();
    openStream(token);
  }

  function openStream(token: number): void {
    firstSnapshotOnStream = true;
    lastStreamActivityAt = now();
    stream = transport.openStream(groupId, clientId, {
      onOpen: () => {
        lastStreamActivityAt = now();
      },
      onSnapshot: (snapshot) => {
        if (token !== connectionToken) return;
        lastStreamActivityAt = now();
        const catchUp = firstSnapshotOnStream;
        firstSnapshotOnStream = false;
        accept(snapshot, { catchUp });
        if (state.connection !== "live") {
          reconnectAttempts = 0;
          partyLog("session.live", { groupId, version: snapshot.version });
          emit({ connection: "live" });
        }
      },
      onPing: () => {
        if (token !== connectionToken) return;
        lastStreamActivityAt = now();
      },
      onClosed: (reason) => {
        if (token !== connectionToken) return;
        if (reason === "expired") {
          // Removed while this tab was away; it is back, so it rejoins.
          scheduleReconnect("expired", true);
          return;
        }
        finish("ended");
      },
      onSuperseded: () => {
        if (token !== connectionToken) return;
        // Another tab presented this tab's id — a duplicated tab carries its
        // parent's session storage. This one steps aside under a new id rather
        // than fight over the old one.
        clientId = replaceClientId();
        partyLog("session.superseded", { groupId });
        emit({ clientId, selfId: `${userId}:${clientId}` });
        scheduleReconnect("superseded", true);
      },
      onError: () => {
        if (token !== connectionToken) return;
        handleFailure(new Error("stream"), "stream");
      },
    });
  }

  function sendStatus(): void {
    if (isEnded() || !registered) return;
    if (statusInFlight) {
      statusAgain = true;
      return;
    }
    statusInFlight = true;
    statusAgain = false;
    const report = desiredStatus;
    const roundTrip = clock.roundTripMs();
    const sentAt = now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      tuning.commandTimeoutMs,
    );

    void transport
      .status(
        groupId,
        {
          clientId,
          status: report.status,
          revision: report.revision,
          ...(roundTrip === null
            ? {}
            : { latencyMs: Math.round(roundTrip / 2) }),
        },
        controller.signal,
      )
      .then(({ serverTimeMs }) => {
        clock.addSample({ sentAt, receivedAt: now(), serverTimeMs });
      })
      .catch((error: unknown) => handleFailure(error, "status"))
      .finally(() => {
        clearTimeout(timeout);
        statusInFlight = false;
        if (statusAgain) sendStatus();
      });
  }

  function watchdog(): void {
    const time = now();
    const late = time - lastWatchdogAt;
    lastWatchdogAt = time;

    if (late > tuning.sleepDetectionMs) {
      partyLog("session.woke", { groupId, sleptMs: late });
      clock.reset();
      scheduleReconnect("woke", true);
      return;
    }
    if (
      state.connection === "live" &&
      time - lastStreamActivityAt > tuning.streamSilenceLimitMs
    ) {
      scheduleReconnect("stream-silent", true);
    }
  }

  const onOnline = () => {
    if (state.connection === "reconnecting") scheduleReconnect("online", true);
  };
  const onOffline = () => {
    if (state.connection === "live") scheduleReconnect("offline");
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    watchdog();
    if (state.connection === "reconnecting") scheduleReconnect("visible", true);
  };

  function attachWindowListeners(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);
  }

  function detachWindowListeners(): void {
    if (typeof window === "undefined") return;
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    document.removeEventListener("visibilitychange", onVisible);
  }

  return {
    clock,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start: () => {
      if (started) return;
      started = true;
      partyLog("session.start", { groupId, rejoin: !initialSnapshot });
      attachWindowListeners();
      keepaliveTimer = setInterval(sendStatus, tuning.keepaliveIntervalMs);
      lastWatchdogAt = now();
      watchdogTimer = setInterval(watchdog, tuning.watchdogIntervalMs);

      if (initialSnapshot) {
        const token = (connectionToken += 1);
        registered = true;
        accept(initialSnapshot, { catchUp: true });
        sendStatus();
        openStream(token);
      } else {
        void connect();
      }
    },

    command: async (command) => {
      if (isEnded()) return "failed";
      const seq = (sequence += 1);
      latestSequence = seq;
      emit({ pendingCommands: state.pendingCommands + 1 });
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        tuning.commandTimeoutMs,
      );
      const sentAt = now();

      try {
        let result = await transport.command(
          groupId,
          { clientId, sequence: seq, ...command },
          controller.signal,
        );
        sequence = Math.max(sequence, result.lastSequence);

        // Rejected as stale although it is this tab's latest: the counter was
        // behind the server's (a reload on a device whose clock went back).
        // Nothing was applied, so sending it again under a fresh number is
        // exactly what the viewer asked for.
        if (
          !result.accepted &&
          seq === latestSequence &&
          result.lastSequence > seq
        ) {
          const retry = (sequence += 1);
          latestSequence = retry;
          partyLog("session.command-resequenced", {
            groupId,
            from: seq,
            to: retry,
          });
          result = await transport.command(
            groupId,
            { clientId, sequence: retry, ...command },
            controller.signal,
          );
          sequence = Math.max(sequence, result.lastSequence);
        }

        clock.addSample({
          sentAt,
          receivedAt: now(),
          serverTimeMs: result.snapshot.serverTimeMs,
        });
        accept(result.snapshot, { catchUp: false });
        if (!result.accepted) {
          partyLog("session.command-ignored", {
            groupId,
            command: command.type,
          });
        }
        emit({ commandFailed: false });
        return result.accepted ? "applied" : "ignored";
      } catch (error) {
        partyLog("session.command-failed", { groupId, command: command.type });
        emit({ commandFailed: true });
        handleFailure(error, "command");
        return "failed";
      } finally {
        clearTimeout(timeout);
        emit({ pendingCommands: state.pendingCommands - 1 });
      }
    },

    setStatus: (status, revision) => {
      if (
        desiredStatus.status === status &&
        desiredStatus.revision === revision
      ) {
        return;
      }
      desiredStatus = { status, revision };
      sendStatus();
    },

    leave: async () => {
      if (isEnded()) return;
      finish("left");
      try {
        await transport.leave(groupId, clientId);
      } catch {
        // The server will expire this tab on its own if the leave is lost.
      }
    },

    end: async () => {
      await transport.end(groupId);
      finish("ended");
    },
  };
}
