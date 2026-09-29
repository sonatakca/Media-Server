/**
 * Party Watch group state: the one authoritative model of a watch party.
 *
 * Every function here is pure — state in, state and a list of what happened
 * out — so the rules that decide what a group does are tested directly rather
 * than inferred from a live session. The runtime owns an instance per group,
 * applies these transitions one at a time (JavaScript gives it that for free),
 * persists the timeline and fans the result out.
 *
 * The model has two halves with different owners:
 *
 * - The **timeline** belongs to the group. It says what the group wants
 *   (`intent`) and where playback is, as an anchor: `positionMs` was true at
 *   server time `anchorMs`, and while the group is effectively playing it
 *   advances in real time from there. Clients extrapolate with a clock offset;
 *   nothing is broadcast on a timer.
 * - **Participants** belong to their clients. A participant is one player — a
 *   browser tab — not a user: two people sharing an account on two devices are
 *   two participants. Each reports its own readiness; the server never guesses
 *   it from positions.
 *
 * Coordinated starts are what keep a group together through the moments that
 * usually tear one apart. A seek, a new title, and a resume after someone has
 * been buffering all require every participant to reposition, and each does so
 * at its own speed. Rather than letting the fast ones run ahead and the slow
 * ones chase a moving target, the group *holds*: the timeline freezes, each
 * participant reports ready once it can play from the frozen position, and the
 * group starts again — for everyone at the same scheduled instant — when the
 * last one is ready. A hold is bounded; a participant that cannot get ready in
 * time is released past and catches up on its own, so one bad connection can
 * delay the group but never stop it.
 */

/**
 * Why each number is what it is. These are behaviour, not implementation
 * detail: change one and the group behaves differently.
 */
export const SYNCPLAY_TUNING = {
  /**
   * How long a coordinated start waits for the slowest participant. A seek on a
   * home connection lands in well under two seconds for both direct files and
   * HLS; this bounds the case where one participant plainly cannot keep up.
   */
  settleTimeoutMs: 8_000,
  /**
   * The same wait after the group changes title. Following a new title means
   * navigating, planning a new playback session and fetching its first bytes,
   * so it gets longer before the group gives up on anyone.
   */
  itemSettleTimeoutMs: 20_000,
  /** How long the group waits for someone who stalled mid-playback. */
  stallHoldTimeoutMs: 12_000,
  /**
   * How long a participant whose stream dropped keeps its place. A refresh or a
   * brief network change reconnects well inside this, silently.
   */
  disconnectGraceMs: 20_000,
  /**
   * A participant is presumed gone once it has said nothing for this long. The
   * client sends a keepalive every 10 s, so this is three missed in a row; the
   * stream alone cannot say it, since a half-open connection looks alive to the
   * server for minutes.
   */
  staleAfterMs: 30_000,
  /** A participant that is silent this long is removed outright. */
  expireAfterMs: 120_000,
  /**
   * A start is scheduled this far past the slowest participant's one-way
   * latency, so the command reaches everyone before the moment it names and
   * they all start together instead of each starting on arrival.
   */
  startLeadMarginMs: 80,
  minStartLeadMs: 120,
  maxStartLeadMs: 1_000,
  /** Assumed one-way latency for a participant that has not measured its own. */
  defaultLatencyMs: 150,
  /**
   * A pause lands where the person who paused saw it — unless their player is
   * this far from the group, in which case the group's position wins, so one
   * desynchronised client cannot drag everyone somewhere else.
   */
  pausePositionTrustMs: 3_000,
} as const;

export type SyncplayTuning = typeof SYNCPLAY_TUNING;

export type GroupIntent = "playing" | "paused";

export type HoldReason = "settling" | "buffering";

export interface GroupHold {
  reason: HoldReason;
  since: number;
  deadline: number;
}

export interface GroupTimeline {
  /** Monotonic across restarts; persisted. Bumped by every timeline change. */
  revision: number;
  itemId: string | null;
  intent: GroupIntent;
  /** Position at `anchorMs`. Does not advance while paused or held. */
  positionMs: number;
  /** Server time at which `positionMs` was (or, for a scheduled start, will be) true. */
  anchorMs: number;
  /**
   * The revision each participant must have applied before the group will
   * start. Raised by anything that moves the position: a seek, a pause, a new
   * title, a buffering hold.
   */
  settleRevision: number;
  hold: GroupHold | null;
}

/** What a client says about its own player. */
export type ParticipantStatus =
  /** Positioning or buffering after a change, a join, or a catch-up. */
  | "loading"
  /** Can play from the group's position now. */
  | "ready"
  /** Was playing along and has stalled for longer than it can absorb alone. */
  | "stalled"
  /** Cannot take part for now (autoplay blocked, player failed). Never waited for. */
  | "away";

/** How the server sees a participant's connection. Derived; never reported. */
export type ParticipantPresence =
  | "connected"
  /** Stream dropped recently; its place is kept for the disconnect grace. */
  | "reconnecting"
  /** Stream nominally open but silent past `staleAfterMs`. */
  | "unresponsive";

export interface Participant {
  /** `${userId}:${clientId}` — a client id is only unique for its user. */
  key: string;
  clientId: string;
  userId: string;
  displayName: string;
  joinedAt: number;
  streamOpen: boolean;
  /** When the stream last closed; set at join until the first stream opens. */
  streamClosedAt: number | null;
  lastSeenAt: number;
  presence: ParticipantPresence;
  status: ParticipantStatus;
  /** The last timeline revision this client reported having applied. */
  readyRevision: number;
  /** Released past by a hold timeout; not waited for until ready again. */
  excluded: boolean;
  /** Highest command sequence accepted from this client. */
  lastCommandSeq: number;
  latencyMs: number | null;
}

export interface GroupState {
  id: string;
  name: string;
  ownerUserId: string;
  timeline: GroupTimeline;
  /** In join order. */
  participants: Participant[];
}

export type GroupCommand =
  | { type: "play" }
  | { type: "pause"; positionMs?: number }
  | { type: "seek"; positionMs: number }
  | { type: "setItem"; itemId: string; fromItemId: string | null };

export type GroupEvent =
  | { type: "command"; command: GroupCommand["type"]; participantKey: string }
  | {
      type: "command-ignored";
      command: GroupCommand["type"];
      participantKey: string;
      reason: "stale-sequence" | "item-changed" | "unknown-participant";
    }
  | { type: "hold-started"; reason: HoldReason; waitingFor: string[] }
  | {
      type: "hold-released";
      reason: HoldReason;
      /** Participants the group stopped waiting for because time ran out. */
      releasedPast: string[];
      waitedMs: number;
    }
  | { type: "participant-joined"; participantKey: string; rejoined: boolean }
  | {
      type: "participant-left";
      participantKey: string;
      reason: "left" | "disconnected" | "silent";
    }
  | {
      type: "participant-status";
      participantKey: string;
      status: ParticipantStatus;
    }
  | {
      type: "participant-presence";
      participantKey: string;
      presence: ParticipantPresence;
    };

export interface Transition {
  state: GroupState;
  events: GroupEvent[];
  /** The timeline moved; persist it and tell everyone. */
  timelineChanged: boolean;
  /** Something visible about a participant changed; tell everyone. */
  participantsChanged: boolean;
}

export function participantKey(userId: string, clientId: string): string {
  return `${userId}:${clientId}`;
}

/** Whether the group is advancing right now. */
export function isAdvancing(timeline: GroupTimeline): boolean {
  return timeline.intent === "playing" && timeline.hold === null;
}

/**
 * Where playback is at server time `now`. Before a scheduled start the
 * position waits at the anchor; it never runs backwards.
 */
export function positionAt(timeline: GroupTimeline, now: number): number {
  if (!isAdvancing(timeline)) return timeline.positionMs;
  return timeline.positionMs + Math.max(0, now - timeline.anchorMs);
}

export function createGroupState(input: {
  id: string;
  name: string;
  ownerUserId: string;
  itemId: string | null;
  now: number;
  revision?: number;
  intent?: GroupIntent;
  positionMs?: number;
  anchorMs?: number;
}): GroupState {
  const revision = input.revision ?? 0;
  return {
    id: input.id,
    name: input.name,
    ownerUserId: input.ownerUserId,
    timeline: {
      revision,
      itemId: input.itemId,
      intent: input.intent ?? "paused",
      positionMs: Math.max(0, input.positionMs ?? 0),
      anchorMs: input.anchorMs ?? input.now,
      settleRevision: revision,
      hold: null,
    },
    participants: [],
  };
}

function isPresent(participant: Participant): boolean {
  return participant.presence === "connected";
}

/** Whether the group would wait for this participant. */
function isHoldEligible(participant: Participant): boolean {
  return (
    isPresent(participant) &&
    participant.status !== "away" &&
    !participant.excluded
  );
}

function isReadyFor(
  participant: Participant,
  timeline: GroupTimeline,
): boolean {
  return (
    participant.status === "ready" &&
    participant.readyRevision >= timeline.settleRevision
  );
}

/** Participants the group is waiting on before it can start. */
export function waitingFor(state: GroupState): Participant[] {
  return state.participants.filter(
    (participant) =>
      isHoldEligible(participant) && !isReadyFor(participant, state.timeline),
  );
}

function startLeadMs(state: GroupState, tuning: SyncplayTuning): number {
  const latencies = state.participants
    .filter(isPresent)
    .map((participant) => participant.latencyMs ?? tuning.defaultLatencyMs);
  const slowest = latencies.length > 0 ? Math.max(...latencies) : 0;
  return Math.min(
    tuning.maxStartLeadMs,
    Math.max(tuning.minStartLeadMs, slowest + tuning.startLeadMarginMs),
  );
}

interface Draft {
  state: GroupState;
  events: GroupEvent[];
  timelineChanged: boolean;
  participantsChanged: boolean;
}

function draftOf(state: GroupState): Draft {
  return {
    state: {
      ...state,
      timeline: { ...state.timeline },
      participants: state.participants.map((participant) => ({
        ...participant,
      })),
    },
    events: [],
    timelineChanged: false,
    participantsChanged: false,
  };
}

function finish(draft: Draft): Transition {
  return {
    state: draft.state,
    events: draft.events,
    timelineChanged: draft.timelineChanged,
    participantsChanged: draft.participantsChanged,
  };
}

function bumpRevision(draft: Draft): void {
  draft.state.timeline.revision += 1;
  draft.timelineChanged = true;
}

/** Everyone must reposition before the next start. */
function requireSettle(draft: Draft): void {
  draft.state.timeline.settleRevision = draft.state.timeline.revision;
}

function beginHold(
  draft: Draft,
  reason: HoldReason,
  now: number,
  timeoutMs: number,
): void {
  const timeline = draft.state.timeline;
  timeline.positionMs = positionAt(timeline, now);
  timeline.anchorMs = now;
  timeline.hold = { reason, since: now, deadline: now + timeoutMs };
}

function startAdvancing(draft: Draft, now: number, tuning: SyncplayTuning) {
  const timeline = draft.state.timeline;
  timeline.hold = null;
  timeline.anchorMs = now + startLeadMs(draft.state, tuning);
}

/**
 * Brings holds in line with who is ready. Called after every change, so a hold
 * can never outlive the reason for it and a stall can never go unheld.
 */
function settle(draft: Draft, now: number, tuning: SyncplayTuning): void {
  const timeline = draft.state.timeline;
  // Presence decays with time, so it is re-derived here rather than trusted
  // from whenever it was last computed.
  for (const participant of draft.state.participants) {
    refreshPresence(draft, participant, now, tuning);
  }

  if (timeline.intent === "paused") {
    timeline.hold = null;
    return;
  }

  if (timeline.hold) {
    const waiting = waitingFor(draft.state);
    const timedOut = now >= timeline.hold.deadline;
    if (waiting.length > 0 && !timedOut) return;

    for (const participant of waiting) participant.excluded = true;
    if (waiting.length > 0) draft.participantsChanged = true;

    draft.events.push({
      type: "hold-released",
      reason: timeline.hold.reason,
      releasedPast: waiting.map((participant) => participant.key),
      waitedMs: now - timeline.hold.since,
    });
    bumpRevision(draft);
    startAdvancing(draft, now, tuning);
    return;
  }

  const stalled = draft.state.participants.filter(
    (participant) =>
      isHoldEligible(participant) && participant.status === "stalled",
  );
  if (stalled.length === 0) return;

  bumpRevision(draft);
  requireSettle(draft);
  beginHold(draft, "buffering", now, tuning.stallHoldTimeoutMs);
  draft.events.push({
    type: "hold-started",
    reason: "buffering",
    waitingFor: stalled.map((participant) => participant.key),
  });
}

function presenceOf(
  participant: Participant,
  now: number,
  tuning: SyncplayTuning,
): ParticipantPresence {
  if (!participant.streamOpen) return "reconnecting";
  if (now - participant.lastSeenAt > tuning.staleAfterMs) return "unresponsive";
  return "connected";
}

function refreshPresence(
  draft: Draft,
  participant: Participant,
  now: number,
  tuning: SyncplayTuning,
): void {
  const presence = presenceOf(participant, now, tuning);
  if (presence === participant.presence) return;
  participant.presence = presence;
  draft.participantsChanged = true;
  draft.events.push({
    type: "participant-presence",
    participantKey: participant.key,
    presence,
  });
}

function findParticipant(draft: Draft, key: string): Participant | undefined {
  return draft.state.participants.find(
    (participant) => participant.key === key,
  );
}

/**
 * Adds a participant, or reattaches one that is still within its grace — a
 * refresh keeps its place and its history rather than reappearing as someone
 * new.
 */
export function joinParticipant(
  state: GroupState,
  input: { userId: string; clientId: string; displayName: string },
  now: number,
  tuning: SyncplayTuning = SYNCPLAY_TUNING,
): Transition {
  const draft = draftOf(state);
  const key = participantKey(input.userId, input.clientId);
  const existing = findParticipant(draft, key);

  if (existing) {
    existing.displayName = input.displayName;
    existing.lastSeenAt = now;
    // A reattaching client reports its readiness afresh; until then it is
    // positioning like any newcomer.
    existing.status = "loading";
    existing.excluded = false;
    refreshPresence(draft, existing, now, tuning);
    draft.participantsChanged = true;
    draft.events.push({
      type: "participant-joined",
      participantKey: key,
      rejoined: true,
    });
  } else {
    draft.state.participants.push({
      key,
      clientId: input.clientId,
      userId: input.userId,
      displayName: input.displayName,
      joinedAt: now,
      streamOpen: false,
      streamClosedAt: now,
      lastSeenAt: now,
      presence: "reconnecting",
      status: "loading",
      readyRevision: 0,
      // Someone arriving mid-film catches up on their own; the group does not
      // stop for a newcomer. Once ready, they are waited for like anyone.
      excluded: isAdvancing(draft.state.timeline),
      lastCommandSeq: 0,
      latencyMs: null,
    });
    draft.participantsChanged = true;
    draft.events.push({
      type: "participant-joined",
      participantKey: key,
      rejoined: false,
    });
  }

  settle(draft, now, tuning);
  return finish(draft);
}

export function removeParticipant(
  state: GroupState,
  key: string,
  reason: "left" | "disconnected" | "silent",
  now: number,
  tuning: SyncplayTuning = SYNCPLAY_TUNING,
): Transition {
  const draft = draftOf(state);
  const before = draft.state.participants.length;
  draft.state.participants = draft.state.participants.filter(
    (participant) => participant.key !== key,
  );
  if (draft.state.participants.length === before) return finish(draft);

  draft.participantsChanged = true;
  draft.events.push({ type: "participant-left", participantKey: key, reason });
  settle(draft, now, tuning);
  return finish(draft);
}

export function setStreamOpen(
  state: GroupState,
  key: string,
  open: boolean,
  now: number,
  tuning: SyncplayTuning = SYNCPLAY_TUNING,
): Transition {
  const draft = draftOf(state);
  const participant = findParticipant(draft, key);
  if (!participant) return finish(draft);

  participant.streamOpen = open;
  participant.streamClosedAt = open ? null : now;
  participant.lastSeenAt = now;
  refreshPresence(draft, participant, now, tuning);
  settle(draft, now, tuning);
  return finish(draft);
}

export interface StatusReport {
  status: ParticipantStatus;
  /** The timeline revision the client has applied. */
  revision: number;
  latencyMs?: number;
}

export function reportStatus(
  state: GroupState,
  key: string,
  report: StatusReport,
  now: number,
  tuning: SyncplayTuning = SYNCPLAY_TUNING,
): Transition {
  const draft = draftOf(state);
  const participant = findParticipant(draft, key);
  if (!participant) return finish(draft);

  participant.lastSeenAt = now;
  refreshPresence(draft, participant, now, tuning);
  if (report.latencyMs !== undefined) participant.latencyMs = report.latencyMs;

  // A report about a revision the group has moved past says nothing about now.
  // The client will report again once it has applied the current one.
  const revision = Math.min(report.revision, draft.state.timeline.revision);
  participant.readyRevision = Math.max(participant.readyRevision, revision);

  if (participant.status !== report.status) {
    participant.status = report.status;
    draft.participantsChanged = true;
    draft.events.push({
      type: "participant-status",
      participantKey: key,
      status: report.status,
    });
  }

  if (participant.excluded && isReadyFor(participant, draft.state.timeline)) {
    participant.excluded = false;
  }

  settle(draft, now, tuning);
  return finish(draft);
}

export function applyCommand(
  state: GroupState,
  key: string,
  sequence: number,
  command: GroupCommand,
  now: number,
  tuning: SyncplayTuning = SYNCPLAY_TUNING,
): Transition {
  const draft = draftOf(state);
  const participant = findParticipant(draft, key);
  const ignore = (
    reason: "stale-sequence" | "item-changed" | "unknown-participant",
  ) => {
    draft.events.push({
      type: "command-ignored",
      command: command.type,
      participantKey: key,
      reason,
    });
    return finish(draft);
  };

  if (!participant) return ignore("unknown-participant");
  participant.lastSeenAt = now;
  refreshPresence(draft, participant, now, tuning);

  // Sequences are per client. They exist for one reason: two requests from the
  // same client can overtake each other in flight, and the older one must not
  // undo the newer. Commands from different clients are applied in the order
  // they arrive — that is the order the group experiences them in.
  if (sequence <= participant.lastCommandSeq) return ignore("stale-sequence");
  participant.lastCommandSeq = sequence;

  const timeline = draft.state.timeline;

  switch (command.type) {
    case "play": {
      if (timeline.intent === "playing") return finish(draft);
      bumpRevision(draft);
      // The paused position is where the group resumes from; re-anchoring
      // first keeps the pause's duration from being counted as playback.
      timeline.anchorMs = now;
      timeline.intent = "playing";
      if (waitingFor(draft.state).length === 0) {
        startAdvancing(draft, now, tuning);
      } else {
        beginHold(draft, "settling", now, tuning.settleTimeoutMs);
        draft.events.push({
          type: "hold-started",
          reason: "settling",
          waitingFor: waitingFor(draft.state).map((p) => p.key),
        });
      }
      break;
    }

    case "pause": {
      if (timeline.intent === "paused") return finish(draft);
      const groupPosition = positionAt(timeline, now);
      const reported = command.positionMs;
      bumpRevision(draft);
      requireSettle(draft);
      timeline.intent = "paused";
      timeline.hold = null;
      timeline.positionMs =
        reported !== undefined &&
        Math.abs(reported - groupPosition) <= tuning.pausePositionTrustMs
          ? Math.max(0, reported)
          : groupPosition;
      timeline.anchorMs = now;
      break;
    }

    case "seek": {
      bumpRevision(draft);
      requireSettle(draft);
      timeline.positionMs = Math.max(0, command.positionMs);
      timeline.anchorMs = now;
      timeline.hold = null;
      if (timeline.intent === "playing") {
        beginHold(draft, "settling", now, tuning.settleTimeoutMs);
        draft.events.push({
          type: "hold-started",
          reason: "settling",
          waitingFor: waitingFor(draft.state).map((p) => p.key),
        });
      }
      break;
    }

    case "setItem": {
      if (command.itemId === timeline.itemId) return finish(draft);
      // Two people choosing "next episode" at once must not skip two episodes:
      // the second request names the title it was moving away from, which is
      // no longer the group's.
      if (timeline.itemId !== null && command.fromItemId !== timeline.itemId) {
        return ignore("item-changed");
      }
      bumpRevision(draft);
      requireSettle(draft);
      timeline.itemId = command.itemId;
      timeline.positionMs = 0;
      timeline.anchorMs = now;
      timeline.hold = null;
      // Nobody is on the new title yet; everyone is waited for, including
      // anyone previously released past.
      for (const member of draft.state.participants) member.excluded = false;
      if (timeline.intent === "playing") {
        beginHold(draft, "settling", now, tuning.itemSettleTimeoutMs);
        draft.events.push({
          type: "hold-started",
          reason: "settling",
          waitingFor: waitingFor(draft.state).map((p) => p.key),
        });
      }
      break;
    }
  }

  draft.events.unshift({
    type: "command",
    command: command.type,
    participantKey: key,
  });
  settle(draft, now, tuning);
  return finish(draft);
}

/**
 * Time-driven transitions: hold deadlines, presence decay and expiry. The
 * runtime calls this on a steady tick; nothing here depends on how often.
 */
export function tick(
  state: GroupState,
  now: number,
  tuning: SyncplayTuning = SYNCPLAY_TUNING,
): Transition {
  const draft = draftOf(state);

  const expired: Array<{ key: string; reason: "disconnected" | "silent" }> = [];
  for (const participant of draft.state.participants) {
    if (
      !participant.streamOpen &&
      participant.streamClosedAt !== null &&
      now - participant.streamClosedAt > tuning.disconnectGraceMs
    ) {
      expired.push({ key: participant.key, reason: "disconnected" });
    } else if (now - participant.lastSeenAt > tuning.expireAfterMs) {
      expired.push({ key: participant.key, reason: "silent" });
    }
  }

  if (expired.length > 0) {
    const gone = new Set(expired.map((entry) => entry.key));
    draft.state.participants = draft.state.participants.filter(
      (participant) => !gone.has(participant.key),
    );
    draft.participantsChanged = true;
    for (const entry of expired) {
      draft.events.push({
        type: "participant-left",
        participantKey: entry.key,
        reason: entry.reason,
      });
    }
  }

  settle(draft, now, tuning);
  return finish(draft);
}
