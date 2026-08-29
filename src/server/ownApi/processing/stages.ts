/**
 * The stages a processing job moves through, and how much of the wall clock
 * each one is worth.
 *
 * Overall progress is a weighted sum rather than "stage N of 9": encoding three
 * video rungs takes minutes while publishing takes milliseconds, and a bar that
 * treats them equally sits at 33% for the entire encode and then leaps. The
 * weights are rough on purpose — they only have to be proportional enough that
 * the bar moves at a believable rate.
 */

export const PROCESSING_STAGES = [
  "waiting",
  "analysing",
  "planning",
  "video",
  "audio",
  "subtitles",
  "packaging",
  "validating",
  "publishing",
  "complete",
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

const STAGE_WEIGHTS: Readonly<Record<ProcessingStage, number>> = {
  waiting: 0,
  analysing: 2,
  planning: 1,
  video: 70,
  audio: 8,
  subtitles: 2,
  packaging: 6,
  validating: 9,
  publishing: 2,
  complete: 0,
};

const TOTAL_WEIGHT = Object.values(STAGE_WEIGHTS).reduce(
  (total, weight) => total + weight,
  0,
);

export function stageWeight(stage: ProcessingStage): number {
  return STAGE_WEIGHTS[stage];
}

export function stageIndex(stage: ProcessingStage): number {
  return PROCESSING_STAGES.indexOf(stage);
}

/**
 * Overall completion, from the current stage and how far into it the job is.
 *
 * Every earlier stage counts in full, whether or not it did any work: a job
 * with no subtitles still passes through the subtitles stage, and a bar that
 * stalled because there was nothing to convert would look like a hang.
 */
export function overallProgress(
  stage: ProcessingStage,
  stageProgress: number,
): number {
  const clampedStageProgress = Math.min(1, Math.max(0, stageProgress));
  const current = stageIndex(stage);
  let completed = 0;
  for (let index = 0; index < current; index += 1) {
    completed += STAGE_WEIGHTS[PROCESSING_STAGES[index]!];
  }
  const value =
    (completed + STAGE_WEIGHTS[stage] * clampedStageProgress) / TOTAL_WEIGHT;
  return Math.min(1, Math.max(0, value));
}

/**
 * Progress that can only move forward.
 *
 * A bar that goes backwards reads as a fault even when the underlying work is
 * fine, and it happens easily: FFmpeg re-reports a lower timestamp after a
 * seek, a stage restarts on retry, two updates arrive out of order. The stored
 * value is therefore a high-water mark.
 */
export function monotonicProgress(previous: number, next: number): number {
  const clamped = Math.min(1, Math.max(0, next));
  return Math.max(previous, clamped);
}

/** Human label for the timeline, in the UI's own words. */
export const STAGE_LABEL_KEYS: Readonly<Record<ProcessingStage, string>> = {
  waiting: "processing.stage.waiting",
  analysing: "processing.stage.analysing",
  planning: "processing.stage.planning",
  video: "processing.stage.video",
  audio: "processing.stage.audio",
  subtitles: "processing.stage.subtitles",
  packaging: "processing.stage.packaging",
  validating: "processing.stage.validating",
  publishing: "processing.stage.publishing",
  complete: "processing.stage.complete",
};
