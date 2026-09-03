/**
 * Asking whether the stretch that stopped an encoder can be read at all.
 *
 * This is the second half of the source-damage diagnosis, and getting the
 * question wrong is worse than not asking it. The first version asked whether
 * the *epoch's start* could be read, which on the drive that motivated all of
 * this is the one part of the interval that demonstrably could: the encoder had
 * already produced eighty-three seconds from it before the platter gave up. The
 * probe answered "readable", the assessment concluded the source was innocent,
 * and a genuinely damaged title was failed as an encoder fault with every
 * checkpoint intact and no replacement built.
 *
 * So the window is the one the encoder could not get through — from where media
 * time froze to the end of the epoch — and it is read the way the encoder read
 * it: sequentially, from a seek, until the bytes stop coming.
 *
 * Two things make the answer trustworthy:
 *
 *  - **Getting through is measured, not assumed.** A demuxer that meets an
 *    unreadable region may stop and exit zero, so a clean exit proves nothing on
 *    its own. What proves the read is the furthest presentation time that came
 *    back: reaching the end of the window is the only thing counted as success.
 *  - **The verdict is bounded, not just the process.** A probe that has not
 *    answered inside its wall clock has already answered — a read of this
 *    region does not come back — and waiting for the kernel to finish unwinding
 *    it adds minutes of nothing. Measured on the failing volume: four minutes
 *    from signal to reap. So the termination is ordered and the answer is given
 *    immediately, with the child left to the runner that owns it.
 */

import { spawnManagedProcess } from "../../processExecution";
import type { SourceProbeOutcome } from "./sourceIo";
import { sanitiseFfmpegLine } from "./sourceIo";

/**
 * Shortest window worth reading.
 *
 * A stall in the last moments of an epoch leaves almost nothing between where
 * media time stopped and the planned end, and a window of a few frames is
 * decided by seek behaviour rather than by the platter. Reading a little past
 * the epoch is harmless — the bytes are the next epoch's, and the question is
 * about the disk, not the plan.
 */
export const MINIMUM_PROBE_SPAN_SECONDS = 5;

/**
 * How much longer than its silence allowance a probe may run in total.
 *
 * Only a backstop: a read that keeps returning data is working, however long it
 * takes, and reaching this is reported as nothing learned rather than as
 * evidence.
 */
export const CEILING_MULTIPLE = 6;

/**
 * How far short of the window's end still counts as having read it.
 *
 * `-read_intervals` stops at the first packet at or past the end, so a healthy
 * read lands within a frame of it. The allowance is for a source whose last
 * keyframe falls just inside the window and for the ordinary imprecision of
 * container timestamps — never enough to let a read that stopped at a bad
 * sector pass as complete, because that shortfall is measured in minutes.
 */
function completionToleranceSeconds(spanSeconds: number): number {
  return Math.max(1, spanSeconds * 0.02);
}

export interface ProbeSourceRangeInput {
  sourcePath: string;
  /** Absolute source seconds to read from: where media time stopped. */
  fromSeconds: number;
  /** Absolute source seconds to read to: normally the end of the epoch. */
  toSeconds: number;
  /**
   * The source's own length, when it is known.
   *
   * Clamps the window, because a read cannot be blamed for not returning
   * packets past the end of the file — which is what an epoch running to the
   * final boundary would otherwise look like.
   */
  sourceDurationSeconds?: number;
  ffprobePath?: string;
  /** How long the read may return nothing before the answer is given. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Injected by tests. */
  spawn?: typeof spawnManagedProcess;
  now?: () => number;
}

/**
 * Reads one interval of the source and reports whether it came back.
 *
 * Packets rather than frames: nothing is decoded, so the cost is the disk and
 * the disk alone, which is the thing being asked about. Never throws — a probe
 * that fails to run is a probe with nothing to say, and the caller must not
 * have to tell that apart from a source that refused to be read.
 */
export async function probeSourceRangeReadable({
  sourcePath,
  fromSeconds,
  toSeconds,
  sourceDurationSeconds,
  ffprobePath = "ffprobe",
  timeoutMs,
  signal,
  spawn = spawnManagedProcess,
  now = Date.now,
}: ProbeSourceRangeInput): Promise<SourceProbeOutcome> {
  const from = Math.max(0, fromSeconds);
  const ceiling =
    sourceDurationSeconds !== undefined && sourceDurationSeconds > 0
      ? sourceDurationSeconds
      : Number.POSITIVE_INFINITY;
  const to = Math.min(
    Math.max(toSeconds, from + MINIMUM_PROBE_SPAN_SECONDS),
    ceiling,
  );
  /*
   * Nothing left between the stall and the end of the file. There is no read to
   * attempt, and inventing one would mean reporting on bytes that do not exist.
   */
  if (to <= from) return { verdict: "readable" };

  const span = to - from;
  let furthest = Number.NEGATIVE_INFINITY;
  let advancedAt = now();
  let pending = "";
  let stderrTail = "";

  const managed = spawn({
    command: ffprobePath,
    args: [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "packet=pts_time",
      "-of",
      "csv=p=0",
      "-read_intervals",
      `${from.toFixed(6)}%${to.toFixed(6)}`,
      sourcePath,
    ],
    ...(signal ? { signal } : {}),
    onStdout: (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const value = Number(line.trim());
        if (Number.isFinite(value) && value > furthest) {
          furthest = value;
          advancedAt = now();
        }
      }
    },
    onStderr: (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
    },
  });

  /*
   * The clock bounds *silence*, not the length of the read — and the difference
   * decides whether film gets replaced with black.
   *
   * A window of five minutes of 4K is a few hundred megabytes, so a healthy but
   * unhurried disk can legitimately spend a while returning it. Timing that out
   * and calling it damage would replace content because the drive was slow. A
   * disk that has stopped answering is the opposite: it returns nothing at all,
   * for as long as Darwin spends retrying the sector. So what is measured is
   * how long it has been since the read last advanced, exactly as the encoder's
   * own watchdog measures media time.
   *
   * There is still a ceiling, because a probe must not run forever, but
   * reaching it while packets are arriving is not evidence against the source —
   * it is a question that did not finish, and it is reported as nothing learned.
   */
  const ceilingMs = timeoutMs * CEILING_MULTIPLE;
  const startedAt = now();
  const stopped = await new Promise<"silent" | "ceiling" | "finished">(
    (resolve) => {
      const tick = setInterval(
        () => {
          if (now() - advancedAt >= timeoutMs) {
            clearInterval(tick);
            managed.abort("wall-clock");
            resolve("silent");
          } else if (now() - startedAt >= ceilingMs) {
            clearInterval(tick);
            managed.abort("wall-clock");
            resolve("ceiling");
          }
        },
        Math.max(50, Math.floor(timeoutMs / 10)),
      );
      tick.unref?.();
      void managed.completed.then(() => {
        clearInterval(tick);
        resolve("finished");
      });
    },
  );

  if (stopped === "silent") {
    return {
      verdict: "timeout",
      detail: `The source stopped returning data ${Math.round(
        timeoutMs / 1000,
      )}s before the read of the window was given up.`,
    };
  }
  if (stopped === "ceiling") {
    /*
     * Still producing when the ceiling arrived. The disk is answering, so
     * nothing here indicts the source, and saying so is the only safe answer.
     */
    return { verdict: "readable" };
  }

  const outcome = await managed.completed;
  /*
   * A probe stopped by anything other than its own wall clock says nothing
   * about the source. The commonest is a person cancelling the job, and
   * reporting that as an unreadable window would replace film over it.
   */
  if (outcome.aborted && outcome.abortReason !== "wall-clock") {
    return { verdict: "readable" };
  }

  const reached = Number.isFinite(furthest) ? furthest : from;
  if (
    outcome.exitCode === 0 &&
    reached >= to - completionToleranceSeconds(span)
  )
    return { verdict: "readable" };

  const line = stderrTail
    .split(/\r?\n/)
    .map((entry) => sanitiseFfmpegLine(entry))
    .filter((entry) => entry.length > 0)
    .at(-1);
  return {
    verdict: "unreadable",
    detail:
      line ??
      `The read stopped ${Math.max(0, Math.round(to - reached))}s short of the window's end.`,
  };
}
