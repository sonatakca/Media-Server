/**
 * What happens when part of the source cannot be read at all.
 *
 * A disk with a bad region is not an encoder fault and not a disconnection. The
 * volume stays mounted, every other byte of the file reads perfectly, and one
 * stretch of it returns `EIO` for ever. Failing the whole title for it throws
 * away hours of correct work and produces nothing; pretending the short output
 * is a whole epoch corrupts the timeline. So there is a third answer, chosen
 * deliberately rather than fallen into: the unreadable interval is replaced by
 * synthetic media of *exactly* the planned length, the title keeps its own
 * timeline, and the substitution is recorded loudly enough that nobody can
 * mistake the result for a clean encode.
 *
 * Everything in this file is pure data and arithmetic. It is imported by the
 * encoder, by the job runner and — as types only — by the browser, so it must
 * not reach for Node.
 */

/**
 * What to do when a source read fails persistently.
 *
 * `fail` is the behaviour that shipped before any of this existed and stays the
 * default: the job ends, every checkpoint is kept, and a person is asked to
 * repair or replace the media. `replace-epoch` trades content for completion —
 * the damaged epoch becomes black video and silence of the same length, and the
 * rest of the title is built normally.
 */
export type SourceDamagePolicy = "fail" | "replace-epoch";

export const SOURCE_DAMAGE_POLICIES: readonly SourceDamagePolicy[] = [
  "fail",
  "replace-epoch",
];

export const DEFAULT_SOURCE_DAMAGE_POLICY: SourceDamagePolicy = "fail";

export function isSourceDamagePolicy(
  value: unknown,
): value is SourceDamagePolicy {
  return (
    typeof value === "string" &&
    SOURCE_DAMAGE_POLICIES.includes(value as SourceDamagePolicy)
  );
}

/**
 * The policy for this deployment.
 *
 * Read from the environment rather than hard-coded so a library sitting on a
 * dying disk can be told to salvage without a code change, while every other
 * deployment keeps the strict behaviour. An unrecognised value is not a reason
 * to fail a job, so it falls back to the strict default.
 */
export function sourceDamagePolicyFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): SourceDamagePolicy {
  const raw = environment.SEYIRLIK_SOURCE_DAMAGE_POLICY?.trim();
  return isSourceDamagePolicy(raw) ? raw : DEFAULT_SOURCE_DAMAGE_POLICY;
}

/** A stretch of the source timeline, in seconds. */
export interface SourceInterval {
  startSeconds: number;
  endSeconds: number;
}

/**
 * One replaced interval, as it is recorded and shown.
 *
 * Deliberately carries no filesystem path. It travels from the worker into the
 * job record and from there into a browser, and the source's location on disk
 * is not something a page has any business knowing.
 */
export interface SourceDamageRecord {
  type: "source-damage";
  epochIndex: number;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  /** The length the replacement must have, to the microsecond. */
  expectedDurationSeconds: number;
  /**
   * Media time the encoder had genuinely produced before the read failed.
   *
   * Kept because it is the one measurement that says how much of the interval
   * was readable, and because a later, finer salvage mode would begin from it.
   */
  lastConfirmedMediaSeconds?: number;
  /** Byte offset FFmpeg reported the read error at, when it named one. */
  ffmpegByteOffset?: number;
  /** Reads of this interval attempted before it was called unreadable. */
  sourceRetryCount: number;
  /** Sanitised FFmpeg lines, bounded, with paths removed. */
  evidence: string[];
  /** True once silence has been substituted for this interval in every track. */
  audioReplaced?: boolean;
  /** True when subtitle cues inside this interval could not be recovered. */
  subtitlesAffected?: boolean;
  detectedAt: string;
}

/** The video part of a damaged interval, as the checkpoint manifest stores it. */
export interface EpochSalvageManifest {
  kind: "source-damage";
  /** Why the epoch is synthetic, in one sentence an operator reads first. */
  reason: string;
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  expectedDurationSeconds: number;
  lastConfirmedMediaSeconds?: number;
  ffmpegByteOffset?: number;
  sourceRetryCount: number;
  evidence: string[];
  createdAt: string;
}

export function damageIntervalOf(record: SourceDamageRecord): SourceInterval {
  return {
    startSeconds: record.sourceStartSeconds,
    endSeconds: record.sourceEndSeconds,
  };
}

/**
 * Merges overlapping or touching intervals into a tidy, ordered set.
 *
 * Two adjacent damaged epochs are one hole as far as audio and subtitles are
 * concerned, and processing them as two would put a range boundary — and the
 * frame of rounding that comes with it — in the middle of a stretch that has
 * nothing to read anyway.
 */
export function mergeIntervals(
  intervals: readonly SourceInterval[],
): SourceInterval[] {
  const usable = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startSeconds) &&
        Number.isFinite(interval.endSeconds) &&
        interval.endSeconds > interval.startSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);
  const merged: SourceInterval[] = [];
  for (const interval of usable) {
    const last = merged[merged.length - 1];
    if (last && interval.startSeconds <= last.endSeconds) {
      last.endSeconds = Math.max(last.endSeconds, interval.endSeconds);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

export type SourceRangeKind = "source" | "synthetic";

export interface SourceRange extends SourceInterval {
  kind: SourceRangeKind;
  durationSeconds: number;
}

/**
 * The whole timeline cut into what can be read and what must be invented.
 *
 * This is the contract the audio stage and the subtitle extractor are built on:
 * the ranges tile `[0, totalSeconds)` exactly, in order, with no gap and no
 * overlap, so anything assembled from them lands on the source's own timeline
 * and the material after a hole is not pulled earlier.
 */
export function planSourceRanges(
  damaged: readonly SourceInterval[],
  totalSeconds: number,
): SourceRange[] {
  if (!(totalSeconds > 0)) return [];
  const holes = mergeIntervals(damaged)
    .map((interval) => ({
      startSeconds: Math.max(0, Math.min(totalSeconds, interval.startSeconds)),
      endSeconds: Math.max(0, Math.min(totalSeconds, interval.endSeconds)),
    }))
    .filter((interval) => interval.endSeconds > interval.startSeconds);

  const ranges: SourceRange[] = [];
  const push = (
    startSeconds: number,
    endSeconds: number,
    kind: SourceRangeKind,
  ): void => {
    const durationSeconds = endSeconds - startSeconds;
    // A range shorter than a millisecond is rounding, not content; giving it
    // its own FFmpeg process would cost more than the frame it carries.
    if (durationSeconds < 0.001) return;
    ranges.push({ startSeconds, endSeconds, durationSeconds, kind });
  };

  let cursor = 0;
  for (const hole of holes) {
    push(cursor, hole.startSeconds, "source");
    push(hole.startSeconds, hole.endSeconds, "synthetic");
    cursor = hole.endSeconds;
  }
  push(cursor, totalSeconds, "source");
  return ranges;
}

/** Whether a moment of the source is inside a hole. */
export function intervalContains(
  intervals: readonly SourceInterval[],
  seconds: number,
): boolean {
  return intervals.some(
    (interval) =>
      seconds >= interval.startSeconds && seconds < interval.endSeconds,
  );
}

/** Total media time replaced, for the one-line summary. */
export function damagedSeconds(intervals: readonly SourceInterval[]): number {
  return mergeIntervals(intervals).reduce(
    (total, interval) => total + (interval.endSeconds - interval.startSeconds),
    0,
  );
}

/** `01:23:45`, for a message naming the interval that was replaced. */
export function formatIntervalClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--:--";
  const whole = Math.floor(seconds);
  const hours = String(Math.floor(whole / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const rest = String(whole % 60).padStart(2, "0");
  return `${hours}:${minutes}:${rest}`;
}

export function describeInterval(interval: SourceInterval): string {
  return `${formatIntervalClock(interval.startSeconds)}–${formatIntervalClock(
    interval.endSeconds,
  )}`;
}
