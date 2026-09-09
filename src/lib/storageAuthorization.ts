/**
 * Whether Seyirlik is allowed to write to library storage at all.
 *
 * This is a gate, not a preference, and it is deliberately not something the
 * page can switch off. The expansion drive has known physical damage and has
 * not been imaged; until that is done, an import that moved real media could
 * write into a region that does not reliably read back. So the interface's job
 * is to say clearly that mutation is not authorised and why — never to offer a
 * control that proceeds anyway.
 *
 * The state is derived rather than stored: the importer is only mounted when a
 * download root is configured, so an absent import subsystem *is* the closed
 * gate. There is nothing to toggle and nothing to get out of step.
 */

export type StorageAuthorization =
  /** The importer is not configured, so nothing can be written. */
  | "not-configured"
  /** Configured and able to run against the roots it was given. */
  | "authorized";

export interface StorageEvidence {
  /**
   * What was measured about the expansion volume, and when.
   *
   * Recorded facts, replayed from a note — never a live query. The drive is
   * out of scope until it has been imaged, and asking it anything, including
   * whether it exists, is exactly what is not allowed.
   */
  readonly volume: string;
  readonly fileSystem: string;
  readonly hardlinksSupported: boolean;
  readonly recordedOn: string;
}

/**
 * What is known about the expansion drive, from the Phase 6 record.
 *
 * Held as a constant because it must not be re-measured. If it is ever wrong,
 * the fix is to image the drive and record a new measurement — not to look
 * again from here.
 */
export const RECORDED_EXPANSION_EVIDENCE: StorageEvidence = {
  volume: "Expansion (D:)",
  fileSystem: "exFAT",
  hardlinksSupported: false,
  recordedOn: "2026-09-08",
};

export interface StorageGate {
  readonly authorization: StorageAuthorization;
  /** True only when media may actually be written. */
  readonly mayMutate: boolean;
  /** Why, in a form the page turns into a sentence. */
  readonly reason: "import-not-configured" | "ready";
}

/**
 * Reads the gate from whether the import subsystem answered at all.
 *
 * A 404 from the imports endpoint is not an error to report: the routes are
 * mounted only when a download root is configured, so its absence is the
 * answer to the question being asked.
 */
export function readStorageGate({
  importsAvailable,
}: {
  importsAvailable: boolean;
}): StorageGate {
  if (!importsAvailable) {
    return {
      authorization: "not-configured",
      mayMutate: false,
      reason: "import-not-configured",
    };
  }
  return { authorization: "authorized", mayMutate: true, reason: "ready" };
}

/**
 * The operation an import would use on the recorded evidence.
 *
 * Not a prediction the importer relies on — it probes the filesystem itself,
 * and that probe is the authority. This is for telling an operator what to
 * expect, and it says `copy` because a volume without hardlinks leaves nothing
 * else that keeps the download.
 */
export function expectedStrategy(
  evidence: StorageEvidence,
  { retainSource }: { retainSource: boolean },
): "hardlink" | "copy" | "move" {
  if (evidence.hardlinksSupported) return "hardlink";
  return retainSource ? "copy" : "move";
}
