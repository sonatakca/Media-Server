/**
 * How long an encoder may produce nothing before something is done about it.
 *
 * There are two thresholds and they answer two different questions, which is
 * why they are not one number with two uses.
 *
 * The **soft** one asks "should the page still be claiming a rate?" It is
 * short, it is reversible, and it changes nothing about the encode: FFmpeg
 * keeps reporting four times a second while it is blocked on a read, with the
 * same `out_time` and a `speed` that falls a little further each time, and
 * showing that is a page confidently animating a throughput for a process
 * doing nothing at all.
 *
 * The **hard** one asks "is this process still worth waiting for?" It ends the
 * attempt. Getting it wrong in one direction kills healthy slow encodes; in the
 * other it is the failure this exists for — a real FFmpeg sat for minutes on a
 * Seagate volume, walking from one unreadable block to the next, while the only
 * reaction in the whole system was a label on a web page.
 *
 * The hard value is chosen from three measurements rather than from taste:
 *
 *  - One application-level read of the damaged region took **35–37 seconds** to
 *    return `EIO`, because Darwin retries a failing sector about twenty times
 *    before giving up. Terminating well inside that window means the encoder is
 *    stopped *before* it can learn of the first failure and move on to the next
 *    bad block — which is what turned one bad region into minutes of thrashing.
 *  - FFmpeg reports every `-stats_period` (a quarter second here), and media
 *    time advances on essentially every report while anything is being encoded.
 *    Even the slowest encode measured on this machine — 4K HDR at 0.07× — moves
 *    `out_time` several times a second, because one *frame* is 40ms of media.
 *    Twenty-five seconds is therefore roughly a hundred consecutive reports
 *    with a frozen timeline: not a slow encoder, a stopped one.
 *  - It is four times the soft threshold, so the two states are visibly
 *    distinct on the page and an ordinary hiccup can never escalate.
 */

/** Media time may stand still this long before the page stops claiming a rate. */
export const SOFT_STALL_AFTER_MS = 6_000;

/**
 * Media time may stand still this long before the attempt is ended.
 *
 * Overridable for a deployment whose storage is slower than anything measured
 * here; not something a caller should be passing around by hand.
 */
export const HARD_STALL_AFTER_MS = 25_000;

/**
 * How long an encoder may produce *nothing at all* before it is ended.
 *
 * Separate from the running threshold, and much longer, because the start of an
 * epoch is the one place where silence is legitimate. An accurate `-ss` decodes
 * forward from the keyframe before the cut and discards, and FFmpeg reports no
 * progress until the first frame it keeps — so a source with long GOPs decoded
 * in software can genuinely say nothing for a minute or more before it is doing
 * anything wrong. Sized to swallow that and still bound a process that never
 * produces a frame at all.
 */
export const STARTUP_STALL_AFTER_MS = 120_000;

/**
 * How long a stalled encoder is given to end politely.
 *
 * Worth waiting for on a healthy process — `SIGTERM` lets FFmpeg finalise what
 * it has written — and worth nothing at all on one wedged in an uninterruptible
 * read, which is why the `SIGKILL` that follows is queued rather than skipped.
 */
export const STALL_TERMINATION_GRACE_MS = 10_000;

/**
 * Longest a bounded readability probe of the source may take.
 *
 * The probe exists to ask "can this part of the file be read at all", and on a
 * failing disk it can enter exactly the same kernel recovery as the encode it
 * is diagnosing. A probe that has not answered inside this window is not
 * inconclusive — it is the same evidence a second time.
 */
export const SOURCE_PROBE_TIMEOUT_MS = 15_000;

function positiveMs(
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  const parsed = Number(raw?.trim());
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.floor(parsed);
}

export interface StallThresholds {
  softStallMs: number;
  hardStallMs: number;
  /** Allowance before the first progress report, where silence is normal. */
  startupStallMs: number;
  terminationGraceMs: number;
  sourceProbeTimeoutMs: number;
}

/**
 * The thresholds this deployment runs with.
 *
 * Read from the environment so a machine with unusually slow storage can be
 * given more rope without a code change, and floored so a typo cannot produce a
 * watchdog that fires during normal startup.
 */
export function stallThresholds(
  environment: Record<string, string | undefined> = process.env,
): StallThresholds {
  const softStallMs = positiveMs(
    environment.SEYIRLIK_SOFT_STALL_MS,
    SOFT_STALL_AFTER_MS,
    1_000,
  );
  return {
    softStallMs,
    hardStallMs: Math.max(
      softStallMs * 2,
      positiveMs(
        environment.SEYIRLIK_HARD_STALL_MS,
        HARD_STALL_AFTER_MS,
        5_000,
      ),
    ),
    startupStallMs: positiveMs(
      environment.SEYIRLIK_STARTUP_STALL_MS,
      STARTUP_STALL_AFTER_MS,
      5_000,
    ),
    terminationGraceMs: positiveMs(
      environment.SEYIRLIK_STALL_KILL_GRACE_MS,
      STALL_TERMINATION_GRACE_MS,
      500,
    ),
    sourceProbeTimeoutMs: positiveMs(
      environment.SEYIRLIK_SOURCE_PROBE_TIMEOUT_MS,
      SOURCE_PROBE_TIMEOUT_MS,
      1_000,
    ),
  };
}
