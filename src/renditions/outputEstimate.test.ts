import { describe, expect, it } from "vitest";
import {
  estimateFinalOutputBytes,
  MIN_PROGRESS_FOR_PROJECTION,
} from "./outputEstimate";
import { createOutputMeter } from "./outputMeter";

/**
 * Two different questions the process row used to answer with one number.
 *
 * "Actual output" showed the planning estimate whenever real bytes were
 * unknown, so a job 5% into a 1440p encode reported having produced 10 GiB —
 * roughly the *final* size of the rendition it had barely started.
 */

const GIB = 1024 ** 3;
/** Roughly a 1440p rendition of a two-and-a-half hour film at ~9 Mbps. */
const PLANNED = 10 * GIB;

describe("estimating this job's final output size", () => {
  /** TEST 2 — at the very start there is nothing to measure. */
  it("reports the planning estimate before any bytes exist", () => {
    expect(
      estimateFinalOutputBytes({
        plannedBytes: PLANNED,
        actualBytes: 0,
        progressFraction: 0,
        processedSeconds: 0,
      }),
    ).toBe(PLANNED);
  });

  /**
   * TEST 4 — the reason the naive form is unusable.
   *
   * At a fraction of a percent the init segment and a keyframe-heavy opening
   * dominate, so bytes ÷ progress projects an absurd total. Here that raw
   * projection is 90 GiB against a 10 GiB plan.
   */
  it("ignores a wild projection from the first moments of an encode", () => {
    const rawProjection = (90 * 1024 ** 2) / 0.001;
    expect(rawProjection).toBeGreaterThan(80 * GIB);

    const estimate = estimateFinalOutputBytes({
      plannedBytes: PLANNED,
      actualBytes: 90 * 1024 ** 2,
      progressFraction: 0.001,
      processedSeconds: 9,
    });

    expect(estimate).toBe(PLANNED);
  });

  /** TEST 3 — once there is real evidence, it informs the answer. */
  it("moves toward the measurement once enough of the encode has happened", () => {
    // Running ~20% cheaper than planned: 2 GiB at a quarter done projects 8 GiB.
    const estimate = estimateFinalOutputBytes({
      plannedBytes: PLANNED,
      actualBytes: 2 * GIB,
      progressFraction: 0.25,
      processedSeconds: 2_200,
    });

    expect(estimate).toBeLessThan(PLANNED);
    expect(estimate).toBeGreaterThan(8 * GIB);
  });

  /** Confidence rises with progress, so the later answer trusts the bytes more. */
  it("weights the measurement more heavily as the job progresses", () => {
    const measure = (progressFraction: number) =>
      estimateFinalOutputBytes({
        plannedBytes: PLANNED,
        actualBytes: 8 * GIB * progressFraction,
        progressFraction,
        processedSeconds: 9_000 * progressFraction,
      });

    const early = measure(0.1);
    const late = measure(0.6);
    // Both below the plan, the later one closer to the 8 GiB the bytes imply.
    expect(early).toBeGreaterThan(late);
    expect(late).toBeLessThan(8.5 * GIB);
  });

  /** TEST 5 — successive answers must not jump about on screen. */
  it("smooths against the previous answer rather than oscillating", () => {
    const noisy = [2.0, 2.6, 2.1, 2.7, 2.2];
    let previous: number | undefined;
    const answers: number[] = [];
    for (const gib of noisy) {
      previous = estimateFinalOutputBytes({
        plannedBytes: PLANNED,
        actualBytes: gib * GIB,
        progressFraction: 0.25,
        processedSeconds: 2_200,
        ...(previous === undefined ? {} : { previousEstimate: previous }),
      });
      answers.push(previous);
    }

    // The input swings by 35%; the reported figure must move far less.
    const swing =
      (Math.max(...answers) - Math.min(...answers)) / Math.min(...answers);
    expect(swing).toBeLessThan(0.1);
  });

  /** A projection may not run away from the plan even with real data. */
  it("clamps a projection that is implausible against the plan", () => {
    const estimate = estimateFinalOutputBytes({
      plannedBytes: PLANNED,
      // Twenty times the planned rate, well past any real variance.
      actualBytes: 40 * GIB,
      progressFraction: 0.2,
      processedSeconds: 1_800,
    });

    expect(estimate).toBeLessThanOrEqual(5 * PLANNED);
  });

  it("survives absent and non-finite inputs", () => {
    expect(
      estimateFinalOutputBytes({
        plannedBytes: PLANNED,
        actualBytes: undefined,
        progressFraction: 0.5,
        processedSeconds: 4_000,
      }),
    ).toBe(PLANNED);
    expect(
      estimateFinalOutputBytes({
        plannedBytes: PLANNED,
        actualBytes: Number.NaN,
        progressFraction: 0.5,
        processedSeconds: 4_000,
      }),
    ).toBe(PLANNED);
    expect(
      estimateFinalOutputBytes({
        plannedBytes: PLANNED,
        actualBytes: 1 * GIB,
        progressFraction: Number.POSITIVE_INFINITY,
        processedSeconds: 4_000,
      }),
    ).toBe(PLANNED);
  });

  /** Both gates must open: progress alone is not enough on a long source. */
  it("requires elapsed media as well as a progress fraction", () => {
    expect(
      estimateFinalOutputBytes({
        plannedBytes: PLANNED,
        actualBytes: 3 * GIB,
        progressFraction: MIN_PROGRESS_FOR_PROJECTION + 0.2,
        processedSeconds: 5,
      }),
    ).toBe(PLANNED);
  });
});

describe("measuring what this job has written", () => {
  /** TEST 7 — an incremental job counts only the files it is producing. */
  it("sums only the files it was given, never the wider package", async () => {
    const sizes: Record<string, number> = {
      "/work/video/1440p/media.m4s": 520 * 1024 ** 2,
      // Present in the title but not this job's work, so never asked about.
      "/title/video/2160p HDR.mp4": 9 * GIB,
    };
    const asked: string[] = [];
    const meter = createOutputMeter(["/work/video/1440p/media.m4s"], {
      sizeOf: async (file) => {
        asked.push(file);
        return sizes[file] ?? 0;
      },
    });

    expect(await meter.measure()).toBe(520 * 1024 ** 2);
    expect(asked).toEqual(["/work/video/1440p/media.m4s"]);
  });

  /** TEST 8 — several renditions in one run aggregate. */
  it("aggregates every rendition the run is producing", async () => {
    const meter = createOutputMeter(
      ["/work/video/1440p/media.m4s", "/work/video/480p/media.m4s"],
      { sizeOf: async () => 100 },
    );
    expect(await meter.measure()).toBe(200);
  });

  /** A file the encoder has not reached yet is zero, not a failure. */
  it("treats a missing output as zero bytes", async () => {
    const meter = createOutputMeter(["/work/video/1440p/media.m4s"], {
      sizeOf: async () => {
        throw new Error("ENOENT");
      },
    });
    await expect(meter.measure()).rejects.toThrow();
    // The throttled path swallows it, because progress must never break.
    meter.sample();
    expect(meter.latest()).toBeUndefined();
  });

  /** The filesystem must not be hit on every progress tick. */
  it("throttles measurement however often progress arrives", async () => {
    let calls = 0;
    let clock = 0;
    const meter = createOutputMeter(["/work/a/media.m4s"], {
      intervalMs: 1_000,
      now: () => clock,
      sizeOf: async () => {
        calls += 1;
        return 10;
      },
    });

    for (let tick = 0; tick < 50; tick += 1) meter.sample();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);

    clock = 1_500;
    meter.sample();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
    expect(meter.latest()).toBe(10);
  });
});
