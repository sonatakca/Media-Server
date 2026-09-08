/**
 * The life of an import, as a state machine whose states are defined by what a
 * crash at that moment leaves on the filesystem.
 *
 * That is the whole design rule here, and it is why these states are not the
 * obvious verbs. An import is a transaction across two systems that cannot be
 * committed together — a filesystem and a database — so every state has to
 * answer one question: if the process died exactly here, what durable evidence
 * would the next process find, and what may it safely do about it?
 *
 * Three of the states are ordinary bookkeeping (`planned`, `validating`,
 * `staging`) because nothing visible to a reader exists yet. One of them,
 * `committing`, is the boundary where the answer is genuinely unknown, and the
 * only legal move out of it is to go and look. And `committed` deliberately
 * does not mean "finished": the source may still be there, and whether that is
 * a leak or the point depends on a retention policy that runs afterwards.
 *
 * The failure vocabulary follows from the same rule. `failed` is a claim —
 * that no destination was activated and the source is untouched — so it may
 * only be used when that is known. Everything else ambiguous is `uncertain`,
 * which is not a worse `failed` but a different thing: an instruction to
 * reconcile against reality before touching anything.
 */

export type ImportState =
  /** The row exists. Nothing has been read and nothing written. */
  | "planned"
  /** Reading the source: exists, stable, a regular file, inside its root. */
  | "validating"
  /**
   * Bytes or links may exist under a staging name inside the library root.
   *
   * Nothing here is visible as library media: a staging artifact is inert, is
   * named after the import that owns it, and is reclaimable without knowing
   * anything else about it.
   */
  | "staging"
  /**
   * Activation is in flight. The destination may or may not exist.
   *
   * The one state whose crash outcome cannot be deduced. A row found here
   * without a live lease must be reconciled by inspecting the filesystem, not
   * retried and not failed.
   */
  | "committing"
  /** The destination is durable and proven. The source may still exist. */
  | "committed"
  /** Removing source data that the retention policy no longer requires. */
  | "cleaning"
  /** Committed, and the source is in the state the policy asked for. */
  | "complete"
  /**
   * Known not to have committed: no destination was activated, the source is
   * untouched. A claim about reality, never a shrug.
   */
  | "failed"
  /**
   * Reality must be inspected before anything else happens.
   *
   * Reached from an ambiguous error — an operation that reported failure but
   * may have succeeded. Handled identically to a stale `committing`; kept
   * separate because how a row arrived here is worth reading months later.
   */
  | "uncertain"
  /**
   * A person has to decide. The destination is occupied by something we did
   * not import, or a file is locked by another process.
   */
  | "needs_attention"
  | "cancelled";

export const IMPORT_STATES: readonly ImportState[] = [
  "planned",
  "validating",
  "staging",
  "committing",
  "committed",
  "cleaning",
  "complete",
  "failed",
  "uncertain",
  "needs_attention",
  "cancelled",
];

/** Nothing leaves these. */
export const TERMINAL_IMPORT_STATES: readonly ImportState[] = [
  "complete",
  "cancelled",
];

/**
 * States that require the filesystem to be inspected before any mutation.
 *
 * Both mean the same thing to the reconciler — look first — and the pair is
 * the reason `failed` can be trusted to mean what it says.
 */
export const UNCERTAIN_IMPORT_STATES: readonly ImportState[] = [
  "committing",
  "uncertain",
];

/**
 * States in which a destination may exist on disk.
 *
 * The question cleanup asks before it is allowed to remove anything, and the
 * question reconciliation asks before it decides an import never happened.
 */
export const MAY_HAVE_DESTINATION: readonly ImportState[] = [
  "committing",
  "committed",
  "cleaning",
  "complete",
  "uncertain",
];

const TRANSITIONS: Record<ImportState, readonly ImportState[]> = {
  planned: ["validating", "failed", "needs_attention", "cancelled"],
  validating: [
    "staging",
    "failed",
    "needs_attention",
    "cancelled",
    // A plan can find the work already done by an earlier attempt.
    "committed",
  ],
  staging: [
    "committing",
    "failed",
    "uncertain",
    "needs_attention",
    "cancelled",
  ],
  /*
   * No path to `failed`. An activation that reported an error may still have
   * happened, so the only honest moves are the two that were proven by
   * looking, plus the state that says looking has not happened yet.
   */
  committing: ["committed", "uncertain", "needs_attention"],
  committed: ["cleaning", "complete", "needs_attention"],
  /*
   * Cleanup cannot un-commit an import. A cleanup that fails leaves the
   * library object exactly as valid as it was, so its failure is reported
   * against the source, never against the commit.
   */
  cleaning: ["complete", "needs_attention"],
  complete: [],
  // An operator may retry a known failure, or give up on it.
  failed: ["planned", "cancelled"],
  /*
   * Reconciliation is the only way out, and it goes wherever the filesystem
   * says: activated, not activated, or occupied by something unexplained.
   */
  uncertain: ["committed", "failed", "needs_attention", "staging"],
  needs_attention: ["planned", "staging", "committed", "failed", "cancelled"],
  cancelled: [],
};

export class ImportTransitionError extends Error {
  readonly from: ImportState;
  readonly to: ImportState;

  constructor(from: ImportState, to: ImportState) {
    super(`An import cannot move from ${from} to ${to}.`);
    this.name = "ImportTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: ImportState, to: ImportState): boolean {
  // Re-observing a state is never an error: a reconciler that finds nothing
  // changed must be able to say so without writing a transition.
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ImportState, to: ImportState): void {
  if (!canTransition(from, to)) throw new ImportTransitionError(from, to);
}

export function isTerminal(state: ImportState): boolean {
  return TERMINAL_IMPORT_STATES.includes(state);
}

export function needsReconciliation(state: ImportState): boolean {
  return UNCERTAIN_IMPORT_STATES.includes(state);
}

export function mayHaveDestination(state: ImportState): boolean {
  return MAY_HAVE_DESTINATION.includes(state);
}

/**
 * Whether the source data must still be preserved.
 *
 * The rule the whole cleanup checkpoint rests on: source may only be removed
 * once a destination is proven durable. Anything unresolved keeps the source,
 * because the source is the only remaining copy of the bytes.
 */
export function mustPreserveSource(state: ImportState): boolean {
  return state !== "cleaning" && state !== "complete";
}

/**
 * How the bytes get from the download to the library.
 *
 * Recorded on the row rather than recomputed, because the correct recovery for
 * a half-finished import depends on which one was chosen — a `move` has
 * already surrendered the source, and a `hardlink` has not.
 */
export type ImportStrategy =
  /** A second directory entry for the same bytes. No copy, no space. */
  | "hardlink"
  /** New bytes, written to a staging name and then activated. */
  | "copy"
  /** A same-volume rename. Atomic, and the source ceases to exist. */
  | "move";

export const IMPORT_STRATEGIES: readonly ImportStrategy[] = [
  "hardlink",
  "copy",
  "move",
];

/** Whether the strategy leaves the source bytes in place when it succeeds. */
export function retainsSourceBytes(strategy: ImportStrategy): boolean {
  // A hardlink shares bytes rather than copying them, so removing the source
  // directory entry costs nothing; a move has no source left to remove.
  return strategy !== "move";
}

export type ImportFailureClass =
  /** The download directory or file is not where the handoff said. */
  | "source-missing"
  /** Still being written, or another process holds it open. */
  | "source-unstable"
  | "source-locked"
  /** Not a regular file: a directory, symlink, junction or device. */
  | "source-not-regular"
  /** A path resolved outside the root it was authorised against. */
  | "path-escape"
  /** Nothing in the download the importer is willing to claim. */
  | "no-media-found"
  /** The destination holds something this import did not put there. */
  | "destination-occupied"
  | "destination-locked"
  /** The filesystem refused the chosen strategy. */
  | "hardlink-unsupported"
  | "cross-volume"
  | "permission-denied"
  | "disk-full"
  /** The name could not be made safe for this filesystem. */
  | "name-unrepresentable"
  /** A write reported failure but may have happened. */
  | "commit-ambiguous"
  | "unknown";

export type ImportDisposition =
  /** Worth trying again unchanged: the world was briefly in the way. */
  | "retry"
  /** Reality must be read before anything else is attempted. */
  | "reconcile"
  /** A person has to look at it. */
  | "attention"
  /** Retrying cannot help. */
  | "terminal";

const DISPOSITIONS: Record<ImportFailureClass, ImportDisposition> = {
  "source-unstable": "retry",
  "source-locked": "retry",
  "destination-locked": "retry",
  "disk-full": "retry",
  "commit-ambiguous": "reconcile",
  "destination-occupied": "attention",
  "source-missing": "attention",
  "no-media-found": "attention",
  "name-unrepresentable": "attention",
  "permission-denied": "attention",
  /*
   * Not retryable and not a fault to escalate: the planner picks a different
   * strategy and the import runs again. Recorded so the choice is explicable.
   */
  "hardlink-unsupported": "terminal",
  "cross-volume": "terminal",
  "source-not-regular": "terminal",
  "path-escape": "terminal",
  unknown: "terminal",
};

export function dispositionFor(failure: ImportFailureClass): ImportDisposition {
  return DISPOSITIONS[failure];
}

/**
 * How many times one import may be attempted before a person is asked.
 *
 * Deliberately small. Import failures are overwhelmingly a locked file or a
 * full disk, and neither is fixed by a fourth attempt a second later.
 */
export const MAX_IMPORT_ATTEMPTS = 3;

export interface ImportRetryPlan {
  action: "retry" | "reconcile" | "attention" | "terminal";
  delayMs: number;
  detail: string;
}

export function planImportRetry(
  failure: ImportFailureClass,
  attempt: number,
  baseDelayMs = 15_000,
): ImportRetryPlan {
  const disposition = dispositionFor(failure);

  // Reconciliation is not an attempt and is not rationed: it reads, and a row
  // that needs reading still needs reading on the tenth restart.
  if (disposition === "reconcile") {
    return {
      action: "reconcile",
      delayMs: 0,
      detail: "The outcome is unknown; the filesystem decides it.",
    };
  }

  if (disposition !== "retry") {
    return {
      action: disposition,
      delayMs: 0,
      detail: `${failure} is not resolved by trying again.`,
    };
  }

  if (attempt >= MAX_IMPORT_ATTEMPTS) {
    return {
      action: "attention",
      delayMs: 0,
      detail: `Still failing after ${MAX_IMPORT_ATTEMPTS} attempts.`,
    };
  }

  return {
    action: "retry",
    delayMs: baseDelayMs * 2 ** Math.max(0, attempt - 1),
    detail: `Attempt ${attempt + 1} of ${MAX_IMPORT_ATTEMPTS}.`,
  };
}

/**
 * What a file in the download is, once the planner has decided about it.
 *
 * `ignored` and `unclaimed` are different on purpose: the first is a file the
 * policy recognises and does not want, the second is one it does not
 * recognise at all. Only the second is worth telling an operator about.
 */
export type ImportFileRole =
  | "media"
  | "subtitle"
  | "metadata"
  | "artwork"
  | "sample"
  | "trailer"
  | "extra"
  | "ignored"
  | "unclaimed";

/**
 * Roles this phase moves into the library. Everything else is left alone.
 *
 * `metadata` is recognised and deliberately not among them. A release's `.nfo`
 * is usually a note about the release, and the library's `.nfo` files are
 * written by Seyirlik's own NFO service — importing one would put a scene text
 * file exactly where that service expects to own the name. It stays in the
 * download, where it can still be read by anyone who wants it.
 */
export const IMPORTED_ROLES: readonly ImportFileRole[] = ["media", "subtitle"];

export function isImported(role: ImportFileRole): boolean {
  return IMPORTED_ROLES.includes(role);
}
