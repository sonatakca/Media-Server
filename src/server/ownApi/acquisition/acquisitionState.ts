/**
 * The life of an acquisition, as a state machine rather than a set of flags.
 *
 * Two properties shape every transition here.
 *
 * SABnzbd is polled, not subscribed, so between two reads a job can move
 * several steps: queued to downloaded is a legal single observation, and a
 * machine that insisted on passing through `downloading` would either invent a
 * state that never happened or refuse the truth. Forward skips are therefore
 * allowed and backward moves are not.
 *
 * And `downloaded` is terminal *for this phase*. It means the bytes are on
 * disk and verified by SABnzbd, not that anything has been imported. The
 * distinction is the whole handoff: importing is somebody else's job and
 * collapsing the two would make "we have it" indistinguishable from "it is in
 * the library".
 */

export type AcquisitionState =
  | "planned"
  | "resolving"
  | "submitting"
  | "queued"
  | "downloading"
  | "processing"
  | "downloaded"
  | "awaiting_retry"
  | "failed"
  | "cancelled"
  | "superseded";

export const ACQUISITION_STATES: readonly AcquisitionState[] = [
  "planned",
  "resolving",
  "submitting",
  "queued",
  "downloading",
  "processing",
  "downloaded",
  "awaiting_retry",
  "failed",
  "cancelled",
  "superseded",
];

/** Nothing leaves these; they are the end of the record. */
export const TERMINAL_STATES: readonly AcquisitionState[] = [
  "downloaded",
  "cancelled",
  "superseded",
];

/**
 * `submitting` is the uncertain one.
 *
 * A response lost after SABnzbd accepted the NZB leaves the row here with no
 * external id, and the only safe move is to look for the job rather than to
 * send it again. Every path out of `submitting` therefore goes through
 * reconciliation, including the one that looks like a plain failure.
 */
const TRANSITIONS: Readonly<
  Record<AcquisitionState, readonly AcquisitionState[]>
> = {
  planned: ["resolving", "cancelled", "superseded", "failed"],
  /*
   * The forward skips are the crash-recovery path. Before sending anything,
   * submission looks for a job already carrying this acquisition's name — and
   * a job left behind by an earlier attempt may be at any point in its life,
   * including finished. Refusing to adopt it would mean sending the NZB a
   * second time, which is the duplicate all of this exists to prevent.
   */
  resolving: [
    "submitting",
    "queued",
    "downloading",
    "processing",
    "downloaded",
    "awaiting_retry",
    "failed",
    "cancelled",
  ],
  submitting: [
    // Forward skips: a poll may first see the job already running or done.
    "queued",
    "downloading",
    "processing",
    "downloaded",
    "awaiting_retry",
    "failed",
    "cancelled",
  ],
  queued: ["downloading", "processing", "downloaded", "failed", "cancelled"],
  downloading: ["processing", "downloaded", "failed", "cancelled"],
  processing: ["downloaded", "failed", "cancelled"],
  // A retry starts the work again from the beginning, or gives up.
  awaiting_retry: ["resolving", "failed", "cancelled", "superseded"],
  // Not terminal: an operator may retry a failure, and a newer acquisition for
  // the same target supersedes it.
  failed: ["awaiting_retry", "superseded", "cancelled"],
  downloaded: [],
  cancelled: [],
  superseded: [],
};

export function isTerminal(state: AcquisitionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(
  from: AcquisitionState,
  to: AcquisitionState,
): boolean {
  // Re-observing the same state is not a transition and is always fine: a poll
  // that finds nothing changed must not be an error.
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export class AcquisitionTransitionError extends Error {
  readonly from: AcquisitionState;
  readonly to: AcquisitionState;

  constructor(from: AcquisitionState, to: AcquisitionState) {
    super(`An acquisition cannot move from ${from} to ${to}.`);
    this.name = "AcquisitionTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(
  from: AcquisitionState,
  to: AcquisitionState,
): void {
  if (!canTransition(from, to)) throw new AcquisitionTransitionError(from, to);
}

/** States in which SABnzbd is expected to know about the job. */
export function expectsExternalJob(state: AcquisitionState): boolean {
  return (
    state === "queued" ||
    state === "downloading" ||
    state === "processing" ||
    state === "submitting"
  );
}

/** Whether more work is expected without an operator doing anything. */
export function isActive(state: AcquisitionState): boolean {
  return !isTerminal(state) && state !== "failed";
}

/**
 * Why an acquisition exists.
 *
 * Kept because the answer changes what a failure should do: an automatic
 * acquisition may fall back to another candidate, where one a person asked for
 * by name should stop and say so.
 */
export type AcquisitionOrigin = "manual" | "automatic" | "fallback" | "retry";

/**
 * Why an acquisition stopped, grouped by what could be done about it.
 *
 * The grouping is the point. A single "failed" string cannot drive a retry
 * policy, and every one of these came from asking "would doing exactly the
 * same thing again plausibly work".
 */
export type FailureClass =
  /** Transient, worth the same request again. */
  | "indexer-unavailable"
  | "sab-unavailable"
  | "submission-timeout"
  | "disk-full"
  /** The release itself is bad; another release might not be. */
  | "nzb-unavailable"
  | "missing-articles"
  | "repair-failed"
  | "unpack-failed"
  | "password-required"
  /** Nothing automatic will fix these. */
  | "indexer-auth"
  | "sab-auth"
  | "removed-externally"
  | "cancelled"
  | "unknown";

export type FailureDisposition =
  /** Try the same release again after a delay. */
  | "retry"
  /** This release will never work; ask the decision engine for another. */
  | "try-another-release"
  /** Stop, and say so. */
  | "terminal";

const DISPOSITIONS: Readonly<Record<FailureClass, FailureDisposition>> = {
  "indexer-unavailable": "retry",
  "sab-unavailable": "retry",
  "submission-timeout": "retry",
  "disk-full": "retry",
  "nzb-unavailable": "try-another-release",
  "missing-articles": "try-another-release",
  "repair-failed": "try-another-release",
  "unpack-failed": "try-another-release",
  // A password will still be required next time, and next week.
  "password-required": "try-another-release",
  "indexer-auth": "terminal",
  "sab-auth": "terminal",
  "removed-externally": "terminal",
  cancelled: "terminal",
  unknown: "terminal",
};

export function dispositionFor(failure: FailureClass): FailureDisposition {
  return DISPOSITIONS[failure];
}

/** Attempts at the same release before giving up on it. */
export const MAX_ATTEMPTS_PER_RELEASE = 3;

export interface RetryPlan {
  readonly action: FailureDisposition | "give-up";
  readonly delayMs: number;
  readonly detail: string;
}

/**
 * What to do after a failure, given how many times this release has been tried.
 *
 * Bounded in both directions: a transient failure retries a fixed number of
 * times and then becomes a reason to try a different release, and a release
 * that is simply bad is never retried at all. Nothing here can loop.
 */
export function planRetry(
  failure: FailureClass,
  attempt: number,
  baseDelayMs = 60_000,
): RetryPlan {
  const disposition = dispositionFor(failure);
  if (disposition === "terminal") {
    return {
      action: "terminal",
      delayMs: 0,
      detail: "Nothing automatic will change this.",
    };
  }
  if (disposition === "try-another-release") {
    return {
      action: "try-another-release",
      delayMs: 0,
      detail: "This release will not work; another candidate might.",
    };
  }
  if (attempt >= MAX_ATTEMPTS_PER_RELEASE) {
    return {
      action: "try-another-release",
      delayMs: 0,
      detail: `Tried ${attempt} times without success.`,
    };
  }
  return {
    action: "retry",
    // Doubling, so a provider that is down for an hour is asked a handful of
    // times rather than every minute.
    delayMs: baseDelayMs * 2 ** (attempt - 1),
    detail: `Transient failure; attempt ${attempt + 1} follows.`,
  };
}
