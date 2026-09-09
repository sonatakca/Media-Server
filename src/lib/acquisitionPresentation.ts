/**
 * How an acquisition reads to somebody who has to decide what to do about it.
 *
 * The server is the authority on what may happen — it refuses a retry from the
 * wrong state and a cancellation of a finished download — and this mirrors
 * those rules so the page does not offer a button that will be refused. Where
 * the two could drift, the server wins: an action offered here and rejected
 * there is a worse outcome than an action not offered.
 */

/** The eleven states an acquisition can be in, as the server names them. */
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

/** Which list an acquisition belongs in. */
export type AcquisitionBucket =
  /** Seyirlik is doing something about it right now. */
  | "active"
  /** Nothing is happening and something should. */
  | "needsAttention"
  /** Done, one way or another. */
  | "finished";

const ACTIVE: readonly AcquisitionState[] = [
  "planned",
  "resolving",
  "submitting",
  "queued",
  "downloading",
  "processing",
  "awaiting_retry",
];

const FINISHED: readonly AcquisitionState[] = [
  "downloaded",
  "cancelled",
  "superseded",
];

export function bucketOf(state: AcquisitionState): AcquisitionBucket {
  if (ACTIVE.includes(state)) return "active";
  if (FINISHED.includes(state)) return "finished";
  // `failed` is the only thing left, and it is the only one waiting on a
  // person: the queue has stopped trying and will not resume by itself.
  return "needsAttention";
}

export interface AcquisitionActions {
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  /** Why an action is unavailable, when saying so is more use than hiding it. */
  readonly cancelBlockedReason?: "already-finished";
}

/**
 * What may be done to an acquisition in this state.
 *
 * Mirrors the server: retry from `failed` only, and never cancel something
 * that has already finished downloading. A cancelled or superseded row is
 * likewise past cancelling.
 */
export function actionsFor(state: AcquisitionState): AcquisitionActions {
  const finished = FINISHED.includes(state);
  return {
    canRetry: state === "failed",
    canCancel: !finished,
    ...(finished ? { cancelBlockedReason: "already-finished" as const } : {}),
  };
}

/**
 * Whether a failure is worth a person's time, or will resolve on its own.
 *
 * `awaiting_retry` is not a failure — the queue is going to try again — so an
 * acquisition sitting there is reported as active rather than as a problem.
 */
export function isWaitingOnSeyirlik(state: AcquisitionState): boolean {
  return state === "awaiting_retry";
}

/** The order the states run in, for drawing progress honestly. */
export const ACQUISITION_PROGRESSION: readonly AcquisitionState[] = [
  "planned",
  "resolving",
  "submitting",
  "queued",
  "downloading",
  "processing",
  "downloaded",
];

/**
 * How far along a running acquisition is, as a step rather than a percentage.
 *
 * SABnzbd is polled, so a download can move several steps between two reads
 * and a percentage would imply a precision nobody measured. A step out of a
 * known list says exactly as much as is actually known. Returns null for a
 * state that is not on the path at all.
 */
export function progressStep(
  state: AcquisitionState,
): { step: number; of: number } | null {
  const index = ACQUISITION_PROGRESSION.indexOf(state);
  if (index === -1) return null;
  return { step: index + 1, of: ACQUISITION_PROGRESSION.length };
}

/** The fourteen failure classes the acquisition service records. */
export type AcquisitionFailureClass =
  | "indexer-unavailable"
  | "indexer-auth"
  | "nzb-unavailable"
  | "sab-unavailable"
  | "sab-auth"
  | "submission-timeout"
  | "disk-full"
  | "missing-articles"
  | "repair-failed"
  | "unpack-failed"
  | "password-required"
  | "removed-externally"
  | "cancelled"
  | "unknown";

export type FailureRemedy =
  /** Seyirlik will try this release again by itself. */
  | "waits"
  /** This release will not work; a different one is needed. */
  | "another-release"
  /** Somebody has to change something outside Seyirlik. */
  | "operator";

/**
 * What a failure means for what happens next.
 *
 * The same three-way split the server plans retries by, said in terms of what
 * the person reading it should do — which is the only reason to show a failure
 * class to a human at all.
 */
export function remedyFor(failure: AcquisitionFailureClass): FailureRemedy {
  switch (failure) {
    case "indexer-unavailable":
    case "sab-unavailable":
    case "submission-timeout":
    case "disk-full":
      return "waits";
    case "nzb-unavailable":
    case "missing-articles":
    case "repair-failed":
    case "unpack-failed":
    case "password-required":
      return "another-release";
    default:
      // Authentication, an external removal, a cancellation, or something
      // unrecognised: none of them get better by waiting.
      return "operator";
  }
}
