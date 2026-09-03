/**
 * How fast this machine actually runs each phase.
 *
 * The whole-job bar divides itself between phases, and to do that it has to
 * predict how long each will take. It used to predict from constants: a fixed
 * 0.3 wall-seconds per media-second of video, a fixed 200 MiB/s of assembly.
 * On the deployment this was written for, assembly runs at about 15 MiB/s
 * across a USB volume — thirteen times slower than the constant — so the bar
 * spent a real half hour crossing four per cent of its width.
 *
 * The fix is to stop guessing where a measurement exists. Every completed job
 * already leaves one behind: the stage history written for the timeline says
 * when each phase began, and the job row says how long the whole thing took
 * and how many bytes it wrote. Dividing one by the other gives this machine's
 * real throughput, for this storage, under this encoder. Nothing new is
 * recorded to obtain it.
 *
 * What remains estimated is stated as such: with no history — a fresh
 * deployment, or a phase no recent job exercised — the constants stand in, and
 * the result says which of its rates were measured and which were assumed.
 */

import type { PhaseTimingRecord } from "./jobStore";
import type { ProcessingStage } from "./stages";

/**
 * The rates the bar's weights are built from.
 *
 * Two are per media-second, three are bytes per second. They are the only
 * quantities that convert a phase's known workload into a comparable cost.
 */
export interface PhaseRates {
  /** Wall seconds spent encoding one second of source video. */
  videoSecondsPerMediaSecond: number;
  /** Wall seconds spent on one second of source audio, per retained track. */
  audioSecondsPerMediaSecondPerTrack: number;
  /** Bytes a second the assembler joins. */
  assemblyBytesPerSecond: number;
  /** Bytes a second verification reads back. */
  verificationBytesPerSecond: number;
  /** Bytes a second publication moves. */
  publishBytesPerSecond: number;
}

export type PhaseRateName = keyof PhaseRates;

/**
 * The fallbacks, and they are exactly that.
 *
 * Order-of-magnitude figures for a mid-range hardware encoder and a local
 * disk. They are used only until the machine has run enough jobs to answer for
 * itself, and every result that contains one says so.
 */
export const ESTIMATED_RATES: PhaseRates = {
  videoSecondsPerMediaSecond: 0.3,
  audioSecondsPerMediaSecondPerTrack: 0.008,
  assemblyBytesPerSecond: 200 * 1024 * 1024,
  verificationBytesPerSecond: 350 * 1024 * 1024,
  publishBytesPerSecond: 400 * 1024 * 1024,
};

/**
 * Bounds each measured rate must fall inside to be believed.
 *
 * A job that was paused for an evening, or one whose row was written by a
 * worker that died and was reconciled later, produces a phase "duration" of
 * hours for a minute of work. The median across several jobs absorbs one of
 * those; these bounds absorb the case where most of the history is like that.
 * A sample outside them is dropped, not clamped — a rate that absurd is
 * evidence about the record, not about the machine.
 */
const PLAUSIBLE: Readonly<Record<PhaseRateName, { min: number; max: number }>> =
  {
    // From ten times slower than real time to fifty times faster.
    videoSecondsPerMediaSecond: { min: 0.002, max: 10 },
    audioSecondsPerMediaSecondPerTrack: { min: 0.00002, max: 1 },
    // From a slow network share to an NVMe array.
    assemblyBytesPerSecond: { min: 1024 * 1024, max: 8 * 1024 ** 3 },
    verificationBytesPerSecond: { min: 1024 * 1024, max: 8 * 1024 ** 3 },
    publishBytesPerSecond: { min: 1024 * 1024, max: 16 * 1024 ** 3 },
  };

/** Samples needed before a measured rate replaces its estimate. */
export const MINIMUM_SAMPLES = 2;

/** Phase durations shorter than this are below the clock's usable resolution. */
const MINIMUM_PHASE_SECONDS = 0.5;

export interface CalibrationResult {
  rates: PhaseRates;
  /** Which rates came from measurement, and from how many jobs. */
  measured: Partial<Record<PhaseRateName, number>>;
  /** Jobs the history offered, before any were discarded as implausible. */
  consideredJobs: number;
}

/** The stage that follows each one, so a phase's end is the next one's start. */
const NEXT_STAGE: Readonly<
  Partial<Record<ProcessingStage, ProcessingStage[]>>
> = {
  video: ["audio", "subtitles", "packaging", "validating", "publishing"],
  audio: ["subtitles", "packaging", "validating", "publishing"],
  packaging: ["validating", "publishing"],
  validating: ["publishing"],
};

/**
 * Seconds one stage lasted in a completed job.
 *
 * The end is whichever later stage was actually reported — a job with no
 * subtitles goes from audio straight to packaging — and for the last phase it
 * is the moment the job finished. Returns null when the boundary cannot be
 * established, which is the honest answer for a job whose history is partial.
 */
export function phaseSeconds(
  record: PhaseTimingRecord,
  stage: ProcessingStage,
): number | null {
  const start = record.stageStartedAt[stage];
  if (!start) return null;
  const candidates = NEXT_STAGE[stage] ?? [];
  let end: Date | null = null;
  for (const candidate of candidates) {
    const at = record.stageStartedAt[candidate];
    if (at) {
      end = at;
      break;
    }
  }
  if (!end) end = record.finishedAt;
  if (!end) return null;
  const seconds = (end.getTime() - start.getTime()) / 1000;
  return seconds >= MINIMUM_PHASE_SECONDS ? seconds : null;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function believable(name: PhaseRateName, value: number): boolean {
  const bounds = PLAUSIBLE[name];
  return Number.isFinite(value) && value >= bounds.min && value <= bounds.max;
}

/**
 * Derives this machine's rates from what its previous jobs actually did.
 *
 * The median is used rather than the mean because the failure mode of this
 * data is one enormous outlier — a job somebody paused overnight — and a mean
 * would carry it into every future prediction.
 *
 * `encoder` narrows the video sample to jobs that used the same encoder, since
 * that is the one phase whose speed changes completely with the hardware
 * chosen. The byte phases are not narrowed: they describe the storage, and a
 * deployment has one library volume.
 */
export function calibratePhaseRates(
  history: readonly PhaseTimingRecord[],
  options: { encoder?: string | null } = {},
): CalibrationResult {
  const samples: Record<PhaseRateName, number[]> = {
    videoSecondsPerMediaSecond: [],
    audioSecondsPerMediaSecondPerTrack: [],
    assemblyBytesPerSecond: [],
    verificationBytesPerSecond: [],
    publishBytesPerSecond: [],
  };

  for (const record of history) {
    const duration = record.sourceDurationSeconds ?? 0;
    const bytes = record.outputBytes;

    const video = phaseSeconds(record, "video");
    if (
      video !== null &&
      duration > 0 &&
      (!options.encoder || record.videoEncoder === options.encoder)
    ) {
      samples.videoSecondsPerMediaSecond.push(video / duration);
    }

    const audio = phaseSeconds(record, "audio");
    if (audio !== null && duration > 0 && record.audioTrackCount > 0) {
      samples.audioSecondsPerMediaSecondPerTrack.push(
        audio / (duration * record.audioTrackCount),
      );
    }

    const assembly = phaseSeconds(record, "packaging");
    if (assembly !== null && bytes > 0) {
      samples.assemblyBytesPerSecond.push(bytes / assembly);
    }

    const verification = phaseSeconds(record, "validating");
    if (verification !== null && bytes > 0) {
      samples.verificationBytesPerSecond.push(bytes / verification);
    }

    const publish = phaseSeconds(record, "publishing");
    if (publish !== null && bytes > 0) {
      samples.publishBytesPerSecond.push(bytes / publish);
    }
  }

  const rates: PhaseRates = { ...ESTIMATED_RATES };
  const measured: Partial<Record<PhaseRateName, number>> = {};
  for (const name of Object.keys(samples) as PhaseRateName[]) {
    const believableSamples = samples[name].filter((value) =>
      believable(name, value),
    );
    if (believableSamples.length < MINIMUM_SAMPLES) continue;
    const value = median(believableSamples);
    if (value === undefined || !believable(name, value)) continue;
    rates[name] = value;
    measured[name] = believableSamples.length;
  }

  return { rates, measured, consideredJobs: history.length };
}

/**
 * One line for the job's own diagnostics, so an operator can see which parts
 * of the bar are measured and which are assumed.
 */
export function describeCalibration(result: CalibrationResult): string {
  const names = Object.keys(result.measured) as PhaseRateName[];
  if (names.length === 0) {
    return (
      "Progress weights are estimates: no comparable completed jobs were found " +
      "to measure this machine's phase throughput from."
    );
  }
  return (
    `Progress weights measured from ${result.consideredJobs} previous ` +
    `${result.consideredJobs === 1 ? "job" : "jobs"} for: ${names
      .map((name) => `${name} (${result.measured[name]} samples)`)
      .join(", ")}. Any phase not listed uses an estimate.`
  );
}
