/**
 * Predicting how large *this job's* output will end up.
 *
 * The planning estimate is duration times a configured bitrate, which is the
 * only thing available before any bytes exist. It is also a guess: the real
 * rate depends on how compressible the material turns out to be. Once enough
 * of the encode has actually happened, the bytes on disk are better evidence
 * than the plan, so the two are blended with confidence rising as the job
 * progresses.
 *
 * The safeguards exist because the naive form — bytes divided by progress —
 * is wildly wrong early. The first seconds carry the init segment, the moov
 * boxes and a keyframe-heavy opening, so at 0.1% progress it can project ten
 * times the true size. Nothing is trusted until there is enough of both
 * progress and elapsed media, the projection is clamped to a sane multiple of
 * the plan, and each answer is smoothed against the last so the figure on
 * screen does not jump between polls.
 */

/** Below this fraction the measurement is startup noise, not a rate. */
export const MIN_PROGRESS_FOR_PROJECTION = 0.05;

/** And below this much encoded media, regardless of fraction. */
export const MIN_SECONDS_FOR_PROJECTION = 20;

/** Confidence in the measurement reaches full weight at this progress. */
const FULL_CONFIDENCE_PROGRESS = 0.5;

/** A projection may not stray beyond these multiples of the planned size. */
const MIN_PLAN_MULTIPLE = 0.2;
const MAX_PLAN_MULTIPLE = 5;

/** How much of the previous answer each new one keeps, to stop it oscillating. */
const SMOOTHING = 0.7;

export interface OutputEstimateInput {
  /** Duration times configured bitrate: what the plan expected this to cost. */
  plannedBytes: number;
  /** Bytes measured on disk for this job so far. */
  actualBytes: number | undefined;
  /** Fraction of the encode completed, 0 to 1. */
  progressFraction: number;
  /** Seconds of source media encoded so far. */
  processedSeconds: number;
  /** The estimate this job last reported, so the answer can be smoothed. */
  previousEstimate?: number | undefined;
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * The current best guess at this job's final output size.
 *
 * Returns the planned figure until the measurement earns its place, then a
 * blend, then — as the job nears the end — essentially the measurement.
 */
export function estimateFinalOutputBytes(input: OutputEstimateInput): number {
  const planned = finite(input.plannedBytes)
    ? Math.max(0, input.plannedBytes)
    : 0;

  const usable =
    finite(input.actualBytes) &&
    input.actualBytes > 0 &&
    finite(input.progressFraction) &&
    input.progressFraction >= MIN_PROGRESS_FOR_PROJECTION &&
    finite(input.processedSeconds) &&
    input.processedSeconds >= MIN_SECONDS_FOR_PROJECTION;

  if (!usable) return planned;

  const projection = input.actualBytes! / input.progressFraction;
  if (!Number.isFinite(projection) || projection <= 0) return planned;

  /*
   * A plan of zero gives nothing to compare against — an unpriced ladder, say —
   * so the measurement stands alone rather than being clamped to nothing.
   */
  const bounded =
    planned > 0
      ? Math.min(
          Math.max(projection, planned * MIN_PLAN_MULTIPLE),
          planned * MAX_PLAN_MULTIPLE,
        )
      : projection;

  const confidence = Math.min(
    1,
    Math.max(
      0,
      (input.progressFraction - MIN_PROGRESS_FOR_PROJECTION) /
        (FULL_CONFIDENCE_PROGRESS - MIN_PROGRESS_FOR_PROJECTION),
    ),
  );
  const blended = planned * (1 - confidence) + bounded * confidence;

  const smoothed = finite(input.previousEstimate)
    ? input.previousEstimate * SMOOTHING + blended * (1 - SMOOTHING)
    : blended;

  return Math.round(Math.max(0, smoothed));
}
