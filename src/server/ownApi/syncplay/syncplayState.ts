/**
 * Authoritative Party Watch state.
 *
 * The server owns the timeline; clients report and obey. Two properties matter
 * and both are pure functions of the stored state, so they are tested here
 * rather than inferred from a live session:
 *
 * 1. Commands are ordered by a monotonic sequence. A command that arrives late
 *    from a slow client is discarded instead of rewinding everyone.
 * 2. Position is stored as an anchor (`positionMs` at `positionUpdatedAt`) and
 *    extrapolated, so a client joining mid-playback lands in the right place
 *    without the server broadcasting on a timer.
 */

export interface SyncplayGroupState {
  sequence: number;
  isPlaying: boolean;
  positionMs: number;
  /** Server clock at which `positionMs` was true. */
  positionUpdatedAt: number;
}

export interface SyncplayMemberState {
  userId: string;
  displayName: string;
  isReady: boolean;
  isBuffering: boolean;
  lastPositionMs: number;
  lastSeenAt: number;
}

export type SyncplayCommand =
  | { type: "play"; positionMs?: number }
  | { type: "pause"; positionMs: number }
  | { type: "seek"; positionMs: number };

export interface CommandResult {
  accepted: boolean;
  state: SyncplayGroupState;
  reason?: "stale-sequence";
}

/**
 * Where playback actually is right now. Paused groups hold their anchor; playing
 * groups advance in real time.
 */
export function currentPositionMs(
  state: SyncplayGroupState,
  now: number,
): number {
  if (!state.isPlaying) return state.positionMs;
  return Math.max(0, state.positionMs + (now - state.positionUpdatedAt));
}

export function applyCommand(
  state: SyncplayGroupState,
  command: SyncplayCommand,
  sequence: number,
  now: number,
): CommandResult {
  // Equal sequences are rejected too: two clients that both believe they are at
  // sequence N must not both win.
  if (sequence <= state.sequence) {
    return { accepted: false, state, reason: "stale-sequence" };
  }

  const base: SyncplayGroupState = {
    ...state,
    sequence,
    positionUpdatedAt: now,
  };

  switch (command.type) {
    case "play":
      return {
        accepted: true,
        state: {
          ...base,
          isPlaying: true,
          positionMs: command.positionMs ?? currentPositionMs(state, now),
        },
      };

    case "pause":
      return {
        accepted: true,
        state: {
          ...base,
          isPlaying: false,
          positionMs: Math.max(0, command.positionMs),
        },
      };

    case "seek":
      return {
        accepted: true,
        state: {
          ...base,
          // A seek keeps the play/pause state; it only moves the anchor.
          positionMs: Math.max(0, command.positionMs),
        },
      };
  }
}

export interface ReadinessDecision {
  /** True when playback should be held because someone cannot keep up. */
  shouldHold: boolean;
  waitingFor: string[];
}

/**
 * Group playback waits for members who are buffering or not yet ready.
 *
 * Members who have gone silent are ignored rather than blocking the group
 * forever: a closed laptop must not freeze everyone else's film.
 */
export function evaluateReadiness(
  members: SyncplayMemberState[],
  now: number,
  staleAfterMs = 15_000,
): ReadinessDecision {
  const active = members.filter(
    (member) => now - member.lastSeenAt <= staleAfterMs,
  );
  const waitingFor = active
    .filter((member) => member.isBuffering || !member.isReady)
    .map((member) => member.userId);

  return { shouldHold: waitingFor.length > 0, waitingFor };
}

/**
 * How far a member has drifted from the group. The player uses this to decide
 * between nudging playback rate and performing a hard seek.
 */
export function memberDriftMs(
  state: SyncplayGroupState,
  member: SyncplayMemberState,
  now: number,
): number {
  return member.lastPositionMs - currentPositionMs(state, now);
}

export const HARD_SEEK_THRESHOLD_MS = 3_000;

export type DriftCorrection = "none" | "nudge" | "seek";

export function driftCorrectionFor(driftMs: number): DriftCorrection {
  const magnitude = Math.abs(driftMs);
  // Below a frame or two, correcting is more disruptive than the drift.
  if (magnitude < 250) return "none";
  if (magnitude < HARD_SEEK_THRESHOLD_MS) return "nudge";
  return "seek";
}
