/**
 * Where a five-minute boundary actually falls in a source's own timestamps.
 *
 * A nominal boundary is a round number; a source's frames are not. At 23.976
 * fps no frame lands on 00:05:00 at all — the neighbours are 299.966 and
 * 300.008 — so "cut at 300" has to be turned into a decision about which of
 * those two frames belongs to which epoch, and that decision has to be made the
 * same way every time the job restarts.
 *
 * The rule is: the epoch owns every frame whose presentation time is at or
 * after the boundary, and FFmpeg is asked to cut *midway between* the two
 * straddling frames. Asking it to cut at the boundary itself would put a real
 * frame within a rounding error of the cut, and a microsecond either way then
 * decides whether that frame is encoded twice or not at all. Half a frame of
 * slack is not a tolerance being relaxed; it is the only place in the interval
 * where no frame exists and therefore the only place a cut is unambiguous.
 */

import { spawn } from "node:child_process";

/** Presentation time as the source stores it, kept as an exact rational. */
export interface SourceTimestamp {
  /** Numerator in the source stream's own time base. */
  ticks: number;
  /** Denominator of the source stream's time base, e.g. 24000. */
  timebase: number;
}

export function timestampSeconds(value: SourceTimestamp): number {
  return value.ticks / value.timebase;
}

/**
 * Converts a source timestamp into a packaged rendition's media timescale.
 *
 * Done in integer arithmetic through the rational rather than by multiplying a
 * float by a timescale, so a two-and-a-half-hour title cannot accumulate a
 * fraction of a tick per epoch into something visible at the end.
 */
export function timestampToTicks(
  value: SourceTimestamp,
  timescale: number,
): number {
  return Math.round((value.ticks * timescale) / value.timebase);
}

export interface StraddlingFrames {
  /** The last frame strictly before the boundary, if the probe saw one. */
  previous?: SourceTimestamp;
  /** The first frame at or after the boundary, if the probe saw one. */
  next?: SourceTimestamp;
}

export interface SourceFrameTimeline {
  timebase: number;
  /** Sorted presentation ticks the probe collected, deduplicated. */
  ticks: number[];
}

const MAX_PROBE_OUTPUT_BYTES = 16 * 1024 * 1024;

function runProcess(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as string);
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("The source timeline probe was cancelled."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_PROBE_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(
          new Error("The source timeline probe produced too much output."),
        );
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(
            `ffprobe failed with exit code ${code ?? "unknown"}: ${stderr}`,
          ),
        );
        return;
      }
      finish(undefined, stdout);
    });
  });
}

function parseTimebase(value: string): number | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || numerator !== 1) return undefined;
  return Number.isFinite(denominator) && denominator > 0
    ? denominator
    : undefined;
}

/**
 * The window read around each boundary.
 *
 * Half a second either side is comfortably more than one frame at any rate the
 * library contains, and the read starts from the keyframe before the window, so
 * the probe always sees both straddling frames. The end is given as an absolute
 * time rather than a duration because `-read_intervals` measures a duration
 * from wherever the *seek* landed, which on a source with sparse keyframes is
 * nowhere near the requested start.
 */
const BOUNDARY_WINDOW_SECONDS = 0.5;

/**
 * Collects presentation timestamps around every nominal boundary.
 *
 * Packets rather than frames: a video packet carries the presentation time of
 * exactly one frame, and reading packets means the probe never decodes, so
 * placing thirty boundaries in a 4K title costs a seek and a few hundred
 * packets rather than a minute of decoding.
 */
export async function probeSourceFrameTimeline({
  sourcePath,
  boundaries,
  ffprobePath = "ffprobe",
  signal,
}: {
  sourcePath: string;
  boundaries: readonly number[];
  ffprobePath?: string;
  signal?: AbortSignal;
}): Promise<SourceFrameTimeline | null> {
  if (boundaries.length === 0) return { timebase: 1000, ticks: [] };

  const intervals = boundaries
    .map((boundary) => {
      const start = Math.max(0, boundary - BOUNDARY_WINDOW_SECONDS);
      const end = boundary + BOUNDARY_WINDOW_SECONDS;
      return `${start.toFixed(6)}%${end.toFixed(6)}`;
    })
    .join(",");

  let output: string;
  try {
    output = await runProcess(
      ffprobePath,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=time_base:packet=pts",
        "-of",
        "compact=p=0:nk=0",
        "-read_intervals",
        intervals,
        sourcePath,
      ],
      signal,
    );
  } catch {
    // A source the prober cannot read is not a reason to refuse to build it:
    // the planner falls back to nominal boundaries, which are correct to within
    // one frame and which the epoch validator still measures afterwards.
    return null;
  }

  let timebase: number | undefined;
  const ticks = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const timebaseField = /(?:^|\|)time_base=([^|]+)/.exec(trimmed);
    if (timebaseField) {
      timebase ??= parseTimebase(timebaseField[1]!);
      continue;
    }
    const ptsField = /(?:^|\|)pts=(-?\d+)/.exec(trimmed);
    if (ptsField) {
      const value = Number(ptsField[1]);
      if (Number.isFinite(value) && value >= 0) ticks.add(value);
    }
  }

  if (timebase === undefined || ticks.size === 0) return null;
  return { timebase, ticks: [...ticks].sort((left, right) => left - right) };
}

/**
 * The two frames a nominal boundary falls between.
 *
 * `previous` is missing when the boundary precedes every frame the probe saw,
 * `next` when it follows all of them — which is how the planner recognises a
 * boundary past the end of the source and stops placing epochs there.
 */
export function straddlingFrames(
  timeline: SourceFrameTimeline,
  boundarySeconds: number,
): StraddlingFrames {
  const boundaryTicks = boundarySeconds * timeline.timebase;
  let previous: number | undefined;
  let next: number | undefined;
  for (const tick of timeline.ticks) {
    if (tick < boundaryTicks) previous = tick;
    else {
      next = tick;
      break;
    }
  }
  return {
    ...(previous === undefined
      ? {}
      : { previous: { ticks: previous, timebase: timeline.timebase } }),
    ...(next === undefined
      ? {}
      : { next: { ticks: next, timebase: timeline.timebase } }),
  };
}

/**
 * The instant to hand FFmpeg as the cut, in seconds.
 *
 * Midway between the two frames, rounded down to the microsecond FFmpeg parses
 * `-ss` into. Rounding down keeps the cut strictly before the frame that starts
 * the next epoch even when the midpoint is not representable, which is the
 * direction that cannot lose a frame.
 */
export function cutSecondsBetween(
  frames: StraddlingFrames,
  boundarySeconds: number,
): number {
  const previous = frames.previous
    ? timestampSeconds(frames.previous)
    : undefined;
  const next = frames.next ? timestampSeconds(frames.next) : undefined;
  if (previous === undefined || next === undefined) return boundarySeconds;
  const midpoint = (previous + next) / 2;
  return Math.floor(midpoint * 1_000_000) / 1_000_000;
}
