/**
 * Whether the bar's weights describe this machine or somebody's guess.
 *
 * The case that prompted this: a library on a USB volume assembles at about
 * 15 MiB/s, and the fallback constant assumes 200 MiB/s. These tests prove the
 * measurement wins once the machine has run enough jobs to have an opinion, and
 * that the estimate is kept — and reported as an estimate — until then.
 */

import { describe, expect, it } from "vitest";
import type { PhaseTimingRecord } from "./jobStore";
import {
  calibratePhaseRates,
  describeCalibration,
  ESTIMATED_RATES,
  phaseSeconds,
} from "./phaseCalibration";
import { GLOBAL_PHASES, planPhaseWeights } from "./jobProgress";

const GIB = 1024 ** 3;
const MIB = 1024 * 1024;

/** Gladiator: 2h50m56s, a 26.86 GiB ladder, three audio tracks. */
const GLADIATOR = {
  sourceDurationSeconds: 10_256,
  audioTrackCount: 3,
  subtitleTrackCount: 2,
  outputBytes: 26.86 * GIB,
};

function at(base: number, offsetSeconds: number): Date {
  return new Date(base + offsetSeconds * 1000);
}

/**
 * A completed job shaped like the real one: a long encode, a short audio pass,
 * and an assembly that crawled across a USB volume at 15.3 MiB/s.
 */
function record(
  overrides: Partial<PhaseTimingRecord> = {},
  timings: {
    video?: number;
    audio?: number;
    packaging?: number;
    validating?: number;
    publishing?: number;
  } = {},
): PhaseTimingRecord {
  const base = Date.UTC(2026, 8, 1);
  const video = timings.video ?? 13_080;
  const audio = timings.audio ?? 240;
  const packaging = timings.packaging ?? 1_798;
  const validating = timings.validating ?? 900;
  const publishing = timings.publishing ?? 60;
  let cursor = 0;
  const stageStartedAt: PhaseTimingRecord["stageStartedAt"] = {};
  stageStartedAt.video = at(base, cursor);
  cursor += video;
  stageStartedAt.audio = at(base, cursor);
  cursor += audio;
  stageStartedAt.packaging = at(base, cursor);
  cursor += packaging;
  stageStartedAt.validating = at(base, cursor);
  cursor += validating;
  stageStartedAt.publishing = at(base, cursor);
  cursor += publishing;

  return {
    sourceDurationSeconds: GLADIATOR.sourceDurationSeconds,
    outputBytes: GLADIATOR.outputBytes,
    videoEncoder: "hevc_videotoolbox",
    hardwareAdapter: "videotoolbox",
    audioTrackCount: 3,
    startedAt: at(base, 0),
    finishedAt: at(base, cursor),
    stageStartedAt,
    ...overrides,
  };
}

describe("phase durations are read off the history already kept", () => {
  it("measures a phase from its own start to the next phase's", () => {
    expect(phaseSeconds(record(), "video")).toBe(13_080);
    expect(phaseSeconds(record(), "packaging")).toBe(1_798);
  });

  it("uses the job's finish time for the last phase", () => {
    expect(phaseSeconds(record(), "publishing")).toBe(60);
  });

  /** A title with no subtitles goes from audio straight to packaging. */
  it("skips stages the job never reported", () => {
    const seconds = phaseSeconds(record(), "audio");
    expect(seconds).toBe(240);
  });

  it("refuses a boundary it cannot establish", () => {
    expect(
      phaseSeconds(
        record({ stageStartedAt: {}, finishedAt: null }, {}),
        "packaging",
      ),
    ).toBeNull();
  });
});

describe("rates come from the machine once it has answered for itself", () => {
  it("keeps the estimates, and says so, with no history", () => {
    const result = calibratePhaseRates([]);
    expect(result.rates).toEqual(ESTIMATED_RATES);
    expect(result.measured).toEqual({});
    expect(describeCalibration(result)).toMatch(/estimates/i);
  });

  it("keeps the estimates until there are enough samples", () => {
    const result = calibratePhaseRates([record()]);
    expect(result.rates.assemblyBytesPerSecond).toBe(
      ESTIMATED_RATES.assemblyBytesPerSecond,
    );
  });

  /**
   * The measurement that matters. Three jobs at the real rate, and the model
   * stops believing in 200 MiB/s.
   */
  it("measures the real assembly throughput of this storage", () => {
    const result = calibratePhaseRates([record(), record(), record()]);
    expect(result.rates.assemblyBytesPerSecond / MIB).toBeCloseTo(15.3, 1);
    expect(result.measured.assemblyBytesPerSecond).toBe(3);
    expect(describeCalibration(result)).toMatch(/measured from 3/);
  });

  it("measures video against the encoder that produced it", () => {
    const result = calibratePhaseRates([record(), record(), record()], {
      encoder: "hevc_videotoolbox",
    });
    // 13 080 wall seconds for 10 256 media seconds.
    expect(result.rates.videoSecondsPerMediaSecond).toBeCloseTo(1.275, 2);
  });

  it("ignores jobs encoded on different hardware when measuring video", () => {
    const others = [
      record({ videoEncoder: "libx265" }),
      record({ videoEncoder: "libx265" }),
      record({ videoEncoder: "libx265" }),
    ];
    const result = calibratePhaseRates(others, {
      encoder: "hevc_videotoolbox",
    });
    expect(result.rates.videoSecondsPerMediaSecond).toBe(
      ESTIMATED_RATES.videoSecondsPerMediaSecond,
    );
    // The byte phases describe the storage, not the encoder, so they still count.
    expect(result.measured.assemblyBytesPerSecond).toBe(3);
  });

  /**
   * A job somebody paused overnight reports an eleven-hour "assembly". The
   * median absorbs it; a mean would carry it into every future prediction.
   */
  it("is not moved by one job that was paused for hours", () => {
    const result = calibratePhaseRates([
      record(),
      record(),
      record({}, { packaging: 40_000 }),
    ]);
    expect(result.rates.assemblyBytesPerSecond / MIB).toBeCloseTo(15.3, 1);
  });

  it("discards samples outside what any storage could do", () => {
    // A phase that "took" a millisecond: the record is wrong, not the disk.
    const impossible = [
      record({}, { packaging: 0.6 }),
      record({}, { packaging: 0.6 }),
      record({}, { packaging: 0.6 }),
    ];
    const result = calibratePhaseRates(impossible);
    expect(result.rates.assemblyBytesPerSecond).toBe(
      ESTIMATED_RATES.assemblyBytesPerSecond,
    );
  });

  it("ignores jobs with no duration or no bytes to divide by", () => {
    const result = calibratePhaseRates([
      record({ sourceDurationSeconds: null, outputBytes: 0 }),
      record({ sourceDurationSeconds: null, outputBytes: 0 }),
      record({ sourceDurationSeconds: null, outputBytes: 0 }),
    ]);
    expect(result.rates).toEqual(ESTIMATED_RATES);
  });
});

describe("what calibration does to the Gladiator bar", () => {
  const share = (
    weights: ReturnType<typeof planPhaseWeights>,
    phase: (typeof GLOBAL_PHASES)[number],
  ) => {
    const total = GLOBAL_PHASES.reduce((sum, entry) => sum + weights[entry], 0);
    return weights[phase] / total;
  };

  /**
   * The number this whole exercise exists for. At the assumed 200 MiB/s a
   * 26.86 GiB assembly is predicted to take 137 seconds; at the measured
   * 15.3 MiB/s it takes 1 798. The bar gave a real half hour of work under four
   * per cent of its width.
   */
  it("corrects an assembly phase that was under-weighted thirteenfold", () => {
    const assumed = planPhaseWeights(GLADIATOR, ESTIMATED_RATES);
    const measured = planPhaseWeights(
      GLADIATOR,
      calibratePhaseRates([record(), record(), record()], {
        encoder: "hevc_videotoolbox",
      }).rates,
    );

    expect(assumed.assembling).toBeCloseTo(137.5, 0);
    expect(measured.assembling).toBeCloseTo(1_798, -1);
    expect(measured.assembling / assumed.assembling).toBeCloseTo(13.1, 0);

    // Share of the bar, which is what an operator actually sees.
    expect(share(assumed, "assembling") * 100).toBeCloseTo(3.8, 0);
    expect(share(measured, "assembling") * 100).toBeCloseTo(11.2, 0);
  });

  it("also corrects a video phase that was assumed four times too fast", () => {
    const assumed = planPhaseWeights(GLADIATOR, ESTIMATED_RATES);
    const measured = planPhaseWeights(
      GLADIATOR,
      calibratePhaseRates([record(), record(), record()], {
        encoder: "hevc_videotoolbox",
      }).rates,
    );
    // 0.3 assumed against 1.275 measured on this machine.
    expect(measured.encoding / assumed.encoding).toBeCloseTo(4.25, 1);
  });
});
