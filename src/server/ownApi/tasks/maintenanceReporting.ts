import {
  type MaintenanceFailureReason,
  type MaintenanceItemFailure,
  type MaintenancePhase,
  type MaintenanceSubject,
} from "../../../lib/maintenance/maintenanceTasks";
import { safeTaskLabel } from "../../../lib/notifications/taskPresentation";

/**
 * How the maintenance jobs turn what went wrong into something a page may
 * show.
 *
 * Two rules, and both of them are the reason this is a module rather than a
 * few lines inside each handler. A failure is recorded as a *code*, so the
 * screen renders a translated sentence and no server text is ever forwarded
 * verbatim. And a failure never carries a path: these operations run against
 * somebody's media volume, and the existing task surface has always refused to
 * put filesystem detail on a card. What is kept is the phase, the reason, and
 * the title's own name where there is one.
 */

/**
 * The most item failures one job record keeps.
 *
 * A library-wide rename that cannot write anywhere would otherwise record one
 * entry per file, and the row is read back into a page. The count of failures
 * is always exact — it comes from a counter, not from this list — so the cap
 * shortens the evidence rather than the finding, and the record says when it
 * has been shortened.
 */
export const MAINTENANCE_FAILURE_LIMIT = 50;

/**
 * The reason behind a filesystem error, from the code the platform put in
 * front of its message.
 *
 * Read from the code alone. The rest of the message is a path and an operation
 * name, which is exactly what must not travel, and the code is the only part
 * of it that means the same thing on every platform.
 */
export function failureReasonFromMessage(
  message: string,
): MaintenanceFailureReason {
  const code = /^([A-Z]{3,12})(?::|\b)/.exec(message.trim())?.[1];
  switch (code) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "permission-denied";
    case "EEXIST":
      return "destination-exists";
    case "ENOENT":
      return "source-missing";
    case "EXDEV":
    case "EBUSY":
    case "EIO":
    case "ENOSPC":
      return "filesystem-error";
    default:
      return code ? "filesystem-error" : "unknown";
  }
}

/** A title's name, or an explicit admission that it cannot be shown. */
export function subjectFromTitle(
  title: string | null | undefined,
): MaintenanceSubject {
  const label = safeTaskLabel(title);
  return label ? { label } : { unnamed: true };
}

/**
 * Collects item failures under the cap, and remembers that it capped.
 *
 * Deliberately not a plain array push at each call site: the cap is a property
 * of the record, and a handler that forgot it would write an unbounded list into
 * a JSONB column.
 */
export function createFailureLog(limit = MAINTENANCE_FAILURE_LIMIT) {
  const failures: MaintenanceItemFailure[] = [];
  let truncated = false;
  return {
    add(
      phase: MaintenancePhase,
      reason: MaintenanceFailureReason,
      subject?: MaintenanceSubject,
    ): void {
      if (failures.length >= limit) {
        truncated = true;
        return;
      }
      failures.push({ phase, reason, ...(subject ? { subject } : {}) });
    },
    /** The record's failure fields, or nothing when there were none. */
    toResult(): {
      failures?: MaintenanceItemFailure[];
      failuresTruncated?: true;
    } {
      if (failures.length === 0) return {};
      return {
        failures,
        ...(truncated ? { failuresTruncated: true as const } : {}),
      };
    },
  };
}
