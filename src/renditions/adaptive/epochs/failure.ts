/**
 * Telling "the drive was pulled out" from "this encode is broken".
 *
 * They produce the same shape of failure — a non-zero exit and an errno on a
 * path — and treating the first as the second is what turned every accidental
 * unplug into a permanently failed job that a person had to notice and retry.
 * The distinction is made from two things together: what the error says, and
 * whether the storage the job needs is answering right now.
 */

export type ProcessingFailureKind =
  | "storage-unavailable"
  | "out-of-space"
  /**
   * The volume is there, mounted, the same device it was, and answering — and
   * the source still will not read. That is not something waiting fixes, so it
   * is deliberately a different kind from `storage-unavailable`: it ends the
   * job and asks for a person rather than parking it for the watchdog.
   */
  | "source-io"
  | "source-missing"
  | "encoder"
  | "unknown";

export interface ClassifiedFailure {
  kind: ProcessingFailureKind;
  /** The sentence an operator reads first. */
  summary: string;
  /** The underlying text, kept so the cause survives into the job record. */
  detail: string;
}

/** Errno spellings that mean the storage stopped answering, not that a file is absent. */
const STORAGE_ERROR_PATTERNS = [
  /\bEIO\b/,
  /Input\/output error/i,
  /\bENXIO\b/,
  /\bENODEV\b/,
  /\bESTALE\b/,
  /Stale file handle/i,
  /Device not configured/i,
  /Transport endpoint is not connected/i,
  /Resource temporarily unavailable on/i,
];

const SPACE_ERROR_PATTERNS = [
  /\bENOSPC\b/,
  /No space left on device/i,
  /Disk quota exceeded/i,
];

const MISSING_PATTERNS = [/\bENOENT\b/, /No such file or directory/i];

export function looksLikeStorageLoss(message: string): boolean {
  return STORAGE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function looksLikeOutOfSpace(message: string): boolean {
  return SPACE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function looksLikeMissingPath(message: string): boolean {
  return MISSING_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Classifies an encode failure.
 *
 * `storageAvailable` is the deciding evidence for the ambiguous cases. An
 * `ENOENT` on an output path is a vanished volume when the volume is gone and a
 * genuine missing file when it is not, and nothing in the message itself can
 * tell the two apart.
 */
export function classifyFailure({
  message,
  storageAvailable,
  missingRoots = [],
  ioRechecksExhausted = false,
}: {
  message: string;
  /** Whether every root the job needs answered its last check. */
  storageAvailable: boolean;
  missingRoots?: readonly string[];
  /**
   * Set once the same epoch has failed to read its source the allowed number of
   * times, with the storage verified present and unchanged between every one of
   * them. Until then an I/O error is read as a drive that is on its way out and
   * the watchdog has not caught up with, which is the common case and the
   * recoverable one.
   */
  ioRechecksExhausted?: boolean;
}): ClassifiedFailure {
  const detail = message.slice(-4000);
  const where = missingRoots.length > 0 ? ` (${missingRoots.join(", ")})` : "";

  if (!storageAvailable) {
    return {
      kind: "storage-unavailable",
      summary: `The storage this job needs became unavailable${where}.`,
      detail,
    };
  }
  if (looksLikeOutOfSpace(message)) {
    return {
      kind: "out-of-space",
      summary: "The output volume ran out of space.",
      detail,
    };
  }
  if (looksLikeStorageLoss(message)) {
    /*
     * The volume has been re-checked after every one of these and was present,
     * readable and on the same device each time. Whatever is failing is the
     * media, not the mount, and parking the job for a watchdog that has nothing
     * to wait for would hide a dying disk behind a progress bar for ever.
     */
    if (ioRechecksExhausted) {
      return {
        kind: "source-io",
        summary:
          "The source could not be read after repeated attempts while its volume stayed available, healthy and unchanged. This looks like damaged media or a failing disk rather than a disconnection.",
        detail,
      };
    }
    return {
      kind: "storage-unavailable",
      summary:
        "The encoder reported an I/O error consistent with storage that stopped answering.",
      detail,
    };
  }
  if (looksLikeMissingPath(message)) {
    return {
      kind: "source-missing",
      summary: "A file the encode needs is no longer where it was.",
      detail,
    };
  }
  return {
    kind: "encoder",
    summary: "The encoder stopped before the epoch was finished.",
    detail,
  };
}

/**
 * A failure that must not be recorded as a defect in the job.
 *
 * Carried as its own class so the layers between the encoder and the job record
 * do not have to re-derive the classification from a string a second time.
 */
export class StorageInterruptedError extends Error {
  readonly failure: ClassifiedFailure;
  constructor(failure: ClassifiedFailure) {
    super(failure.summary);
    this.name = "StorageInterruptedError";
    this.failure = failure;
  }
}

/**
 * A read failure that waiting will not fix.
 *
 * Separate from `StorageInterruptedError` because the two demand opposite
 * handling: that one parks the job for the watchdog, this one ends it and asks
 * for a person. Every checkpoint is kept either way — the epochs already on
 * disk are still valid, and a retry after the source is repaired or replaced
 * re-encodes only the epoch that could not be read.
 */
export class SourceReadError extends Error {
  readonly failure: ClassifiedFailure;
  /** Which epoch could not be read, so the message can name the minutes. */
  readonly epochIndex: number;
  readonly attempts: number;
  constructor(
    failure: ClassifiedFailure,
    epochIndex: number,
    attempts: number,
  ) {
    super(failure.summary);
    this.name = "SourceReadError";
    this.failure = failure;
    this.epochIndex = epochIndex;
    this.attempts = attempts;
  }
}
