/**
 * What "34.2%" means, and how long it says there is left.
 *
 * The page used to show a weighted sum of workflow stages, so a job that had
 * reached a late stage read as nearly done while FFmpeg was a third of the way
 * through the film. Video progress here is one thing only: how much of the
 * source timeline has actually been encoded. Every other stage — assembling,
 * validating, publishing — is reported as itself rather than folded into that
 * number.
 */

export interface EpochProgressInput {
  /** Media time covered by epochs that are already durable. */
  protectedSeconds: number;
  /** Where the running epoch's own timeline starts. */
  currentEpochStartSeconds: number;
  /** FFmpeg's `out_time` for the running epoch. */
  currentEpochProcessedSeconds: number;
  sourceDurationSeconds: number;
}

export interface EpochProgressSnapshot {
  /** Media time encoded so far, protected plus the epoch in flight. */
  encodedSeconds: number;
  /** The same as a fraction of the source, clamped to [0,1]. */
  encodedFraction: number;
  protectedSeconds: number;
}

/**
 * Encoded media time.
 *
 * Deliberately measured from the running epoch's *own* start rather than from
 * the protected mark: an epoch that is being redone after an interruption
 * starts at the boundary before the loss, and adding its progress to the
 * protected mark would count that stretch twice and run the bar past the end.
 */
export function epochProgress({
  protectedSeconds,
  currentEpochStartSeconds,
  currentEpochProcessedSeconds,
  sourceDurationSeconds,
}: EpochProgressInput): EpochProgressSnapshot {
  const encodedSeconds = Math.max(
    protectedSeconds,
    Math.min(
      sourceDurationSeconds,
      currentEpochStartSeconds + Math.max(0, currentEpochProcessedSeconds),
    ),
  );
  return {
    encodedSeconds,
    encodedFraction:
      sourceDurationSeconds > 0
        ? Math.min(1, Math.max(0, encodedSeconds / sourceDurationSeconds))
        : 0,
    protectedSeconds,
  };
}

/**
 * A throughput estimate that does not lurch.
 *
 * FFmpeg's first few `speed` samples are dominated by process start, filter
 * graph construction and the seek preroll, and taking them at face value shows
 * an ETA of days for the first seconds of every epoch. They are dropped, and
 * what follows is smoothed exponentially so a passing stall bends the estimate
 * rather than replacing it.
 */
export interface SpeedEstimator {
  /** Feeds one sample. Returns the smoothed value, or undefined while warming. */
  sample(speed: number | undefined): number | undefined;
  readonly value: number | undefined;
  readonly samples: number;
}

/** Samples ignored at the start of each epoch, at four reports a second. */
export const SPEED_WARMUP_SAMPLES = 8;
/** Weight given to the newest sample. */
export const SPEED_SMOOTHING = 0.15;

export function createSpeedEstimator({
  warmupSamples = SPEED_WARMUP_SAMPLES,
  smoothing = SPEED_SMOOTHING,
}: { warmupSamples?: number; smoothing?: number } = {}): SpeedEstimator {
  let seen = 0;
  let smoothed: number | undefined;
  return {
    sample(speed) {
      if (speed === undefined || !Number.isFinite(speed) || speed <= 0) {
        return smoothed;
      }
      seen += 1;
      if (seen <= warmupSamples) return smoothed;
      smoothed =
        smoothed === undefined
          ? speed
          : smoothed + smoothing * (speed - smoothed);
      return smoothed;
    },
    get value() {
      return smoothed;
    },
    get samples() {
      return seen;
    },
  };
}

/**
 * Seconds of wall clock left in the *video* stage.
 *
 * Only the encode is estimated. Assembly is a byte copy whose cost is a
 * fraction of it, and validation and publication are shown as their own stages,
 * so folding them in would trade a number that can be trusted for one that
 * cannot.
 */
export function estimateEncodeEtaSeconds({
  encodedSeconds,
  sourceDurationSeconds,
  smoothedSpeed,
}: {
  encodedSeconds: number;
  sourceDurationSeconds: number;
  smoothedSpeed: number | undefined;
}): number | undefined {
  if (!smoothedSpeed || smoothedSpeed <= 0) return undefined;
  const remaining = Math.max(0, sourceDurationSeconds - encodedSeconds);
  const eta = remaining / smoothedSpeed;
  return Number.isFinite(eta) ? Math.round(eta) : undefined;
}

/**
 * Interpolated media time between authoritative samples, for a bar that moves.
 *
 * Bounded by the next epoch boundary and by the last confirmed value plus the
 * time that has genuinely passed, so it can drift ahead of the truth by at most
 * the reporting interval and can never invent completion. A stalled encoder
 * reaches the bound and stops, which is the honest picture.
 */
export function interpolatedMediaSeconds({
  confirmedSeconds,
  confirmedAtMs,
  nowMs,
  smoothedSpeed,
  upperBoundSeconds,
}: {
  confirmedSeconds: number;
  confirmedAtMs: number;
  nowMs: number;
  smoothedSpeed: number | undefined;
  upperBoundSeconds: number;
}): number {
  if (!smoothedSpeed || smoothedSpeed <= 0 || nowMs <= confirmedAtMs) {
    return Math.min(confirmedSeconds, upperBoundSeconds);
  }
  const elapsed = (nowMs - confirmedAtMs) / 1000;
  return Math.min(
    upperBoundSeconds,
    confirmedSeconds + elapsed * smoothedSpeed,
  );
}
