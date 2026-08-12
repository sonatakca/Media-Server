/**
 * The pure half of the dual-deck quality switch.
 *
 * Everything here is a function of its arguments: no DOM, no timers, no React.
 * The orchestration in `prepareStandbyDeck` and `useSeamlessQualitySwitch`
 * consults this module for every decision that could be got wrong quietly —
 * whether a target may be promoted, whether a request has been superseded,
 * whether a source pair is even a candidate for a seamless handoff.
 */

/** The two video elements. Neither is "the" player; roles swap on promotion. */
export type DeckId = "a" | "b";

export const OTHER_DECK: Record<DeckId, DeckId> = { a: "b", b: "a" };

/** Why the switch was asked for. Drives diagnostics and the failure policy. */
export type SwitchReason = "auto-upgrade" | "auto-downgrade" | "manual";

export type SwitchPhase =
  | "idle"
  /** The target URL is attached to the standby deck and metadata is pending. */
  | "preparing"
  /** Metadata arrived; the standby is seeking to the rendezvous point. */
  | "seeking"
  /** Seek landed; buffering ahead and priming the decoder. */
  | "priming"
  /** A decoded frame exists and every promotion rule is satisfied. */
  | "ready"
  /** The visual and audio swap is in flight. */
  | "handing-off"
  /** Promoted, but the old deck is retained in case the new one fails. */
  | "stabilizing"
  | "failed"
  | "cancelled";

export type SwitchOutcome =
  | "promoted"
  | "superseded"
  | "cancelled"
  | "failed"
  | "rolled-back";

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Largest timeline discontinuity the handoff may introduce.
 *
 * A quarter second is roughly the point where a cut stops reading as a change
 * of quality and starts reading as a skip. The rendezvous scheme normally lands
 * an order of magnitude inside this; the check exists to refuse a promotion
 * that would not.
 */
export const MAX_HANDOFF_DRIFT_SECONDS = 0.25;

/**
 * Media that must be buffered past the handoff point before promoting.
 *
 * Promoting with less means the viewer trades a black frame for a spinner one
 * second later, which is the same interruption moved rather than removed.
 */
export const MIN_BUFFER_AHEAD_SECONDS = 2;

/**
 * How far ahead of the playhead the standby parks itself.
 *
 * The standby seeks here, decodes a frame, and waits with that frame painted
 * until the active deck's clock arrives. One second is comfortably longer than
 * the priming work that follows the seek, so the rendezvous is normally reached
 * by waiting rather than by seeking again.
 */
export const HANDOFF_LEAD_SECONDS = 1;

/**
 * How close the two clocks should actually be when the swap happens.
 *
 * `MAX_HANDOFF_DRIFT_SECONDS` is the ceiling — the point past which a promotion
 * is refused. This is the target. The standby parks ahead and the playhead
 * closes the gap continuously, so promoting the moment the gap merely falls
 * under the ceiling would throw away the accuracy the rendezvous was set up to
 * get. Waiting the extra few frames until the clocks genuinely meet costs
 * nothing and lands the handoff within about one frame at 30fps.
 */
export const RENDEZVOUS_TARGET_SECONDS = 0.05;

/**
 * Minimum remaining runway when the standby becomes frame-ready.
 *
 * If preparation ate the whole lead, the rendezvous point is already behind the
 * playhead and the standby has to re-seek further ahead instead of promoting
 * into the past.
 */
export const MIN_RENDEZVOUS_MARGIN_SECONDS = 0.15;

/** Re-seeks allowed before preparation is declared failed. */
export const MAX_RENDEZVOUS_ATTEMPTS = 3;

/**
 * When the active deck is paused there is no clock to meet, so the standby
 * matches the exact position instead. Frame-accurate for a still picture.
 */
export const PAUSED_SYNC_TOLERANCE_SECONDS = 0.05;

/**
 * Longest preparation may run before it is abandoned.
 *
 * Reaching it is a *failure*, never a promotion: the old quality keeps playing.
 */
export const PREPARE_DEADLINE_MS = 25_000;

/** How long the old deck is kept loaded after promotion, for rollback. */
export const STABILIZE_MS = 1_500;

/**
 * Opacity crossfade at the swap. Short enough to hide a single-frame timing
 * seam and far too short to read as a dissolve.
 */
export const HANDOFF_CROSSFADE_MS = 80;

/** After an Auto target fails, how long before that same rung is retried. */
export const AUTO_RETRY_BACKOFF_MS = 90_000;

/** `HTMLMediaElement.readyState` levels this module reasons about. */
export const HAVE_METADATA = 1;
export const HAVE_CURRENT_DATA = 2;
export const HAVE_FUTURE_DATA = 3;

/* -------------------------------------------------------------------------- */
/* Readiness                                                                  */
/* -------------------------------------------------------------------------- */

export type ReadinessBlocker =
  | "no-metadata"
  | "no-duration"
  | "ready-state"
  | "buffer"
  | "no-frame"
  | "drift"
  | "superseded"
  | "failed";

export interface StandbyReadiness {
  hasMetadata: boolean;
  durationSeconds: number;
  readyState: number;
  /** Seconds buffered continuously past the intended handoff point. */
  bufferedAheadSeconds: number;
  /** The point the standby is parked at and has decoded. */
  handoffPointSeconds: number;
  hasDecodedFrame: boolean;
  superseded: boolean;
  failed: boolean;
}

/**
 * Buffer required past the handoff point, capped by what the file can supply.
 *
 * A switch two seconds before the end can never buffer two seconds ahead, and
 * refusing to promote there would mean the last moments of every title silently
 * never upgrade.
 */
export function requiredBufferAheadSeconds(
  handoffPointSeconds: number,
  durationSeconds: number,
): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return MIN_BUFFER_AHEAD_SECONDS;
  }

  return Math.max(
    0,
    Math.min(MIN_BUFFER_AHEAD_SECONDS, durationSeconds - handoffPointSeconds),
  );
}

/**
 * Whether the standby is prepared enough to be considered for promotion.
 *
 * Deliberately says nothing about drift: while priming, the standby is parked
 * ahead of the playhead on purpose.
 */
export function evaluateStandbyReadiness(readiness: StandbyReadiness): {
  ready: boolean;
  blockedBy: ReadinessBlocker[];
} {
  const blockedBy: ReadinessBlocker[] = [];

  if (readiness.failed) blockedBy.push("failed");
  if (readiness.superseded) blockedBy.push("superseded");
  if (!readiness.hasMetadata) blockedBy.push("no-metadata");
  if (
    !Number.isFinite(readiness.durationSeconds) ||
    readiness.durationSeconds <= 0
  ) {
    blockedBy.push("no-duration");
  }
  if (readiness.readyState < HAVE_FUTURE_DATA) blockedBy.push("ready-state");
  if (
    readiness.bufferedAheadSeconds <
    requiredBufferAheadSeconds(
      readiness.handoffPointSeconds,
      readiness.durationSeconds,
    )
  ) {
    blockedBy.push("buffer");
  }
  if (!readiness.hasDecodedFrame) blockedBy.push("no-frame");

  return { ready: blockedBy.length === 0, blockedBy };
}

export interface PromotionReadiness extends StandbyReadiness {
  activePositionSeconds: number;
  /** The standby's own clock, which is what will be shown after the swap. */
  standbyPositionSeconds: number;
  isActivePaused: boolean;
}

/**
 * The complete promotion gate: prepared, and standing at the right instant.
 *
 * Nothing else may promote a deck. In particular there is no timeout branch —
 * an expired budget produces a failure, not a swap.
 */
export function evaluatePromotionReadiness(readiness: PromotionReadiness): {
  promotable: boolean;
  blockedBy: ReadinessBlocker[];
  driftSeconds: number;
} {
  const { ready, blockedBy } = evaluateStandbyReadiness(readiness);
  const driftSeconds = Math.abs(
    readiness.standbyPositionSeconds - readiness.activePositionSeconds,
  );
  const tolerance = readiness.isActivePaused
    ? PAUSED_SYNC_TOLERANCE_SECONDS
    : MAX_HANDOFF_DRIFT_SECONDS;
  const allBlockers = [...blockedBy];

  if (driftSeconds > tolerance) allBlockers.push("drift");

  return {
    promotable: ready && driftSeconds <= tolerance,
    blockedBy: allBlockers,
    driftSeconds,
  };
}

/* -------------------------------------------------------------------------- */
/* Eligibility                                                                */
/* -------------------------------------------------------------------------- */

export type SeamlessBlocker =
  | "not-complete-file"
  | "hls-source"
  | "not-seekable"
  | "timeline-mismatch"
  | "audio-encode-change"
  | "codec-unsupported"
  | "party-watch-seek"
  | "same-quality";

export interface SeamlessEligibilityInput {
  /** Both sides are validated, complete, range-served files. */
  currentIsCompleteFile: boolean;
  targetIsCompleteFile: boolean;
  targetIsHls: boolean;
  targetIsSeekable: boolean;
  /** Same media, same duration, so positions mean the same thing on both. */
  sameTimeline: boolean;
  /** A different audio encode cannot be handed over frame-to-frame. */
  changesAudioEncode: boolean;
  /** `canPlayType` on the standby said something other than "". */
  targetCodecPlayable: boolean;
  partyWatchSeekInFlight: boolean;
  sameQuality: boolean;
}

/**
 * Whether this particular change may use the dual-deck path.
 *
 * Everything it rejects still has a working route through the existing
 * controlled source replacement; the point is that nothing gets the seamless
 * path by accident just because it happens to be a quality-shaped request.
 */
export function evaluateSeamlessEligibility(input: SeamlessEligibilityInput): {
  eligible: boolean;
  blockedBy: SeamlessBlocker[];
} {
  const blockedBy: SeamlessBlocker[] = [];

  if (input.sameQuality) blockedBy.push("same-quality");
  if (!input.currentIsCompleteFile || !input.targetIsCompleteFile) {
    blockedBy.push("not-complete-file");
  }
  if (input.targetIsHls) blockedBy.push("hls-source");
  if (!input.targetIsSeekable) blockedBy.push("not-seekable");
  if (!input.sameTimeline) blockedBy.push("timeline-mismatch");
  if (input.changesAudioEncode) blockedBy.push("audio-encode-change");
  if (!input.targetCodecPlayable) blockedBy.push("codec-unsupported");
  if (input.partyWatchSeekInFlight) blockedBy.push("party-watch-seek");

  return { eligible: blockedBy.length === 0, blockedBy };
}

/** Auto climbing, Auto retreating, or the viewer asking. */
export function classifySwitchReason(
  fromHeight: number | null,
  toHeight: number,
  isManual: boolean,
): SwitchReason {
  if (isManual) return "manual";
  if (fromHeight !== null && toHeight < fromHeight) return "auto-downgrade";
  return "auto-upgrade";
}

/* -------------------------------------------------------------------------- */
/* Transition model                                                           */
/* -------------------------------------------------------------------------- */

export interface SwitchRequest {
  /** Monotonic. A request may only act while it holds the highest token. */
  token: number;
  reason: SwitchReason;
  fromQualityId: string | null;
  toQualityId: string;
  fromHeight: number | null;
  toHeight: number;
  /** The deck the target is being prepared on. */
  targetDeck: DeckId;
  startedAtMs: number;
}

export interface SwitchTimings {
  metadataReadyMs?: number;
  seekCompleteMs?: number;
  frameReadyMs?: number;
  handoffStartedMs?: number;
  promotedMs?: number;
  settledMs?: number;
}

export interface SwitchMeasurements {
  handoffPointSeconds?: number;
  bufferedAheadSeconds?: number;
  driftAtHandoffSeconds?: number;
  rendezvousAttempts?: number;
}

export interface SwitchState {
  phase: SwitchPhase;
  request: SwitchRequest | null;
  timings: SwitchTimings;
  measurements: SwitchMeasurements;
  outcome?: SwitchOutcome;
  failureReason?: string;
}

export const initialSwitchState: SwitchState = {
  phase: "idle",
  request: null,
  timings: {},
  measurements: {},
};

export type SwitchEvent =
  | { type: "request"; request: SwitchRequest }
  | { type: "metadata-ready"; token: number; atMs: number }
  | {
      type: "seek-complete";
      token: number;
      atMs: number;
      handoffPointSeconds: number;
      rendezvousAttempts: number;
    }
  | {
      type: "frame-ready";
      token: number;
      atMs: number;
      bufferedAheadSeconds: number;
    }
  | {
      type: "handoff-start";
      token: number;
      atMs: number;
      driftAtHandoffSeconds: number;
    }
  | { type: "promoted"; token: number; atMs: number }
  | { type: "settled"; token: number; atMs: number }
  | { type: "fail"; token: number; atMs: number; reason: string }
  | { type: "rollback"; token: number; atMs: number; reason: string }
  | { type: "cancel"; token: number; atMs: number }
  | { type: "reset" };

const ACTIVE_PHASES: ReadonlySet<SwitchPhase> = new Set<SwitchPhase>([
  "preparing",
  "seeking",
  "priming",
  "ready",
  "handing-off",
  "stabilizing",
]);

export function isSwitchInFlight(state: SwitchState): boolean {
  return ACTIVE_PHASES.has(state.phase);
}

/** True once the swap has happened and only cleanup remains. */
export function hasPromoted(state: SwitchState): boolean {
  return state.phase === "stabilizing" || state.outcome === "promoted";
}

/**
 * Phase order, used to reject events that arrive out of sequence — a stray
 * `seeked` after promotion must not drag the machine backwards.
 */
const PHASE_RANK: Record<SwitchPhase, number> = {
  idle: 0,
  preparing: 1,
  seeking: 2,
  priming: 3,
  ready: 4,
  "handing-off": 5,
  stabilizing: 6,
  failed: 7,
  cancelled: 7,
};

export function reduceSwitch(
  state: SwitchState,
  event: SwitchEvent,
): SwitchState {
  if (event.type === "reset") {
    return initialSwitchState;
  }

  if (event.type === "request") {
    // A newer request always wins. The older one can no longer promote because
    // every subsequent event of its own carries the stale token.
    return {
      phase: "preparing",
      request: event.request,
      timings: {},
      measurements: {},
      outcome:
        state.request && isSwitchInFlight(state) ? "superseded" : undefined,
    };
  }

  // Supersession and cancellation are the same guard: an event may only move
  // the machine while its request is still the authoritative one.
  if (!state.request || event.token !== state.request.token) {
    return state;
  }

  switch (event.type) {
    case "cancel":
      return { ...state, phase: "cancelled", outcome: "cancelled" };

    case "fail":
      return {
        ...state,
        phase: "failed",
        outcome: "failed",
        failureReason: event.reason,
      };

    case "rollback":
      return {
        ...state,
        phase: "failed",
        outcome: "rolled-back",
        failureReason: event.reason,
      };

    case "metadata-ready":
      if (PHASE_RANK[state.phase] > PHASE_RANK.preparing) return state;
      return {
        ...state,
        phase: "seeking",
        timings: { ...state.timings, metadataReadyMs: event.atMs },
      };

    case "seek-complete":
      if (PHASE_RANK[state.phase] > PHASE_RANK.seeking) return state;
      return {
        ...state,
        phase: "priming",
        timings: { ...state.timings, seekCompleteMs: event.atMs },
        measurements: {
          ...state.measurements,
          handoffPointSeconds: event.handoffPointSeconds,
          rendezvousAttempts: event.rendezvousAttempts,
        },
      };

    case "frame-ready":
      if (PHASE_RANK[state.phase] > PHASE_RANK.priming) return state;
      return {
        ...state,
        phase: "ready",
        timings: { ...state.timings, frameReadyMs: event.atMs },
        measurements: {
          ...state.measurements,
          bufferedAheadSeconds: event.bufferedAheadSeconds,
        },
      };

    case "handoff-start":
      // Promotion is reachable only from `ready`. There is no path into the
      // swap that skips the readiness gate.
      if (state.phase !== "ready") return state;
      return {
        ...state,
        phase: "handing-off",
        timings: { ...state.timings, handoffStartedMs: event.atMs },
        measurements: {
          ...state.measurements,
          driftAtHandoffSeconds: event.driftAtHandoffSeconds,
        },
      };

    case "promoted":
      if (state.phase !== "handing-off") return state;
      return {
        ...state,
        phase: "stabilizing",
        timings: { ...state.timings, promotedMs: event.atMs },
      };

    case "settled":
      if (state.phase !== "stabilizing") return state;
      return {
        ...state,
        phase: "idle",
        outcome: "promoted",
        timings: { ...state.timings, settledMs: event.atMs },
      };

    default:
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The development record of one switch.
 *
 * Quality ids and heights only — no URLs, tokens from the media server, paths
 * or session identifiers ever reach this shape, so there is nothing to redact
 * at the log call.
 */
export interface SwitchDiagnostics {
  token: number;
  reason: SwitchReason;
  fromQualityId: string | null;
  toQualityId: string;
  fromHeight: number | null;
  toHeight: number;
  targetDeck: DeckId;
  outcome: SwitchOutcome;
  preparationStartedAtMs: number;
  metadataReadyAfterMs?: number;
  seekCompleteAfterMs?: number;
  frameReadyAfterMs?: number;
  targetSeekPositionSeconds?: number;
  bufferedSecondsAhead?: number;
  driftAtHandoffSeconds?: number;
  rendezvousAttempts?: number;
  preparationDurationMs?: number;
  handoffDurationMs?: number;
  failureReason?: string;
}

function since(startMs: number, atMs?: number): number | undefined {
  return atMs === undefined ? undefined : Math.round(atMs - startMs);
}

export function buildSwitchDiagnostics(
  state: SwitchState,
  outcome: SwitchOutcome,
): SwitchDiagnostics | null {
  const request = state.request;
  if (!request) return null;

  const start = request.startedAtMs;
  const { timings, measurements } = state;

  return {
    token: request.token,
    reason: request.reason,
    fromQualityId: request.fromQualityId,
    toQualityId: request.toQualityId,
    fromHeight: request.fromHeight,
    toHeight: request.toHeight,
    targetDeck: request.targetDeck,
    outcome,
    preparationStartedAtMs: start,
    metadataReadyAfterMs: since(start, timings.metadataReadyMs),
    seekCompleteAfterMs: since(start, timings.seekCompleteMs),
    frameReadyAfterMs: since(start, timings.frameReadyMs),
    targetSeekPositionSeconds: measurements.handoffPointSeconds,
    bufferedSecondsAhead: measurements.bufferedAheadSeconds,
    driftAtHandoffSeconds: measurements.driftAtHandoffSeconds,
    rendezvousAttempts: measurements.rendezvousAttempts,
    preparationDurationMs: since(start, timings.frameReadyMs),
    handoffDurationMs:
      timings.handoffStartedMs === undefined || timings.promotedMs === undefined
        ? undefined
        : Math.round(timings.promotedMs - timings.handoffStartedMs),
    failureReason: state.failureReason,
  };
}
