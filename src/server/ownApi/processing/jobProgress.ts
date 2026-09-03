/**
 * One bar for the whole job, and what its position means.
 *
 * The old model weighted the nine *stages* with constants that had nothing to
 * do with the title being processed: every job spent 70% of its bar on video
 * whether the source was three minutes or three hours, and the remaining
 * phases divided a fixed 27% between them regardless of whether there were
 * eight renditions to assemble or one. It moved, and it was not measuring
 * anything.
 *
 * This model asks a different question. Before the encode starts the plan
 * already says how much work each phase will do: how many media-seconds to
 * encode, how many tracks of audio, how many bytes to join, to read back, to
 * publish. Those are real quantities in different units, so each is divided by
 * a *rate* — this machine's measured throughput for that phase — to give a
 * predicted duration, and the ratios between those durations are what the bar
 * is made of.
 *
 * The rates come from `phaseCalibration`, which reads them off the machine's
 * own completed jobs. Where it has no history the documented estimates stand
 * in, and the job's diagnostics say which. That is the honest boundary of this
 * file: the workloads are exact, the rates are measured where a measurement
 * exists and assumed where none does, and the bar is drawn without a number
 * because of the second half of that sentence.
 */

import type { BuildPhase } from "./liveProgress";
import { ESTIMATED_RATES, type PhaseRates } from "./phaseCalibration";

/** A floor so a phase with no measurable work still occupies a sliver. */
const MINIMUM_PHASE_UNITS = 0.5;

/** The phases the bar is divided into, in the order they run. */
export const GLOBAL_PHASES = [
  "analysing",
  "planning",
  "encoding",
  "audio",
  "subtitles",
  "assembling",
  "validating",
  "publishing",
] as const;

export type GlobalPhase = (typeof GLOBAL_PHASES)[number];

export type PhaseWeights = Readonly<Record<GlobalPhase, number>>;

export interface PhaseWorkPlan {
  sourceDurationSeconds: number;
  /** Audio tracks this job will encode. Zero when the stage is reused. */
  audioTrackCount: number;
  /** Subtitle tracks this job will extract. */
  subtitleTrackCount: number;
  /**
   * Bytes the assembler will join, and the verifier will then read back.
   *
   * The plan's estimate before the encode; the assembler replaces it with the
   * exact figure once the checkpoints exist, but the weights are already
   * committed by then and are deliberately not revised.
   */
  outputBytes: number;
}

/**
 * The weights for one job, committed once.
 *
 * Committed rather than continuously refined for a specific reason: the bar is
 * `completed + current × fraction` over the total, so changing any weight
 * changes the total, and a total that grows makes a bar that has not moved
 * appear to move backwards. Better a boundary that is approximately right and a
 * bar that only ever advances.
 */
export function planPhaseWeights(
  plan: PhaseWorkPlan,
  rates: PhaseRates = ESTIMATED_RATES,
): PhaseWeights {
  const duration = Math.max(0, plan.sourceDurationSeconds);
  const bytes = Math.max(0, plan.outputBytes);
  const units = (value: number): number =>
    Math.max(MINIMUM_PHASE_UNITS, Number.isFinite(value) ? value : 0);
  /** Predicted seconds to move `bytes` at a measured or assumed rate. */
  const atRate = (rate: number): number =>
    rate > 0 ? bytes / rate : MINIMUM_PHASE_UNITS;

  return {
    // Probing a source: seconds, whatever the title.
    analysing: MINIMUM_PHASE_UNITS,
    // Reading the source's frame timeline to cut epochs on real boundaries.
    planning: units(duration * 0.002),
    encoding: units(duration * rates.videoSecondsPerMediaSecond),
    audio: units(
      duration *
        rates.audioSecondsPerMediaSecondPerTrack *
        plan.audioTrackCount,
    ),
    // Subtitle extraction is a text copy; it is here so the phase exists.
    subtitles: units(plan.subtitleTrackCount * 1),
    assembling: units(atRate(rates.assemblyBytesPerSecond)),
    validating: units(atRate(rates.verificationBytesPerSecond)),
    publishing: units(atRate(rates.publishBytesPerSecond)),
  };
}

/** Which global phase a build phase belongs to. */
const PHASE_FOR_BUILD_PHASE: Readonly<Record<BuildPhase, GlobalPhase>> = {
  planning: "planning",
  encoding: "encoding",
  audio: "audio",
  subtitles: "subtitles",
  assembling: "assembling",
  validating: "validating",
  publishing: "publishing",
};

export function globalPhaseFor(phase: BuildPhase): GlobalPhase {
  return PHASE_FOR_BUILD_PHASE[phase];
}

/**
 * Cumulative progress across the whole job.
 *
 * Every phase before the current one counts in full — a job that skipped
 * subtitles because there were none still passed the point where they would
 * have been — and the current one counts for the fraction it has measurably
 * completed. Nothing here knows about time.
 */
export function globalProgress(
  weights: PhaseWeights,
  phase: GlobalPhase,
  phaseFraction: number,
): number {
  const total = GLOBAL_PHASES.reduce(
    (sum, entry) => sum + Math.max(0, weights[entry]),
    0,
  );
  if (total <= 0) return 0;
  const index = GLOBAL_PHASES.indexOf(phase);
  if (index < 0) return 0;

  let completed = 0;
  for (let position = 0; position < index; position += 1) {
    completed += Math.max(0, weights[GLOBAL_PHASES[position]!]);
  }
  const fraction = Number.isFinite(phaseFraction)
    ? Math.min(1, Math.max(0, phaseFraction))
    : 0;
  const value = (completed + Math.max(0, weights[phase]) * fraction) / total;
  /*
   * Held below one however the arithmetic lands. The bar reaching its end is
   * reserved for a job whose row says it succeeded, because "finished" is a
   * fact about the database and the published package, not about the last
   * phase's byte counter.
   */
  return Math.min(0.999, Math.max(0, value));
}

/**
 * Progress that can only move forward.
 *
 * Re-exported shape of the same rule the stage model uses: a bar that goes
 * backwards reads as a fault even when the work is fine, and every phase here
 * has a legitimate way of producing a lower sample than the one before it — a
 * retried epoch, a restarted assembly, two updates landing out of order.
 */
export function monotonic(previous: number, next: number): number {
  // A sample that is not a number is not a lower sample; it is no sample. The
  // page must never be handed NaN to set a width from.
  if (!Number.isFinite(next)) return previous;
  return Math.max(previous, Math.min(1, Math.max(0, next)));
}
