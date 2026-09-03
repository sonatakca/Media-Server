/**
 * The arithmetic every phase panel is drawn from.
 *
 * These are the numbers an operator reads while deciding whether to wait or to
 * intervene, so the tests are written against the real proportions of a real
 * title rather than against round numbers that hide a weighting bug.
 */

import { describe, expect, it } from "vitest";
import type { AssemblyPhaseProgress } from "./phaseProgress";
import {
  buildAssemblyProgress,
  createByteRateEstimator,
  etaFromRate,
  safeFraction,
} from "./phaseProgress";

const GIB = 1024 ** 3;

/** Gladiator's real ladder, in the sizes it actually assembles. */
const GLADIATOR: ReadonlyArray<[string, number]> = [
  ["2160p", 10.18 * GIB],
  ["1440p", 7.31 * GIB],
  ["1080p", 4.76 * GIB],
  ["720p", 2.48 * GIB],
  ["480p", 1.26 * GIB],
  ["360p", 0.47 * GIB],
  ["240p", 0.26 * GIB],
  ["144p", 0.14 * GIB],
];

const IDS = GLADIATOR.map(([id]) => id);
const EXPECTED = new Map(GLADIATOR);

function progress(
  written: Record<string, number>,
  finished: string[],
  currentId?: string,
  bytesPerSecond?: number,
) {
  return buildAssemblyProgress({
    renditionIds: IDS,
    expected: EXPECTED,
    written: new Map(IDS.map((id) => [id, written[id] ?? 0])),
    finished: new Set(finished),
    ...(currentId === undefined ? {} : { currentId }),
    ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
  });
}

describe("assembly progress is weighted by bytes, not by rungs", () => {
  /**
   * The acceptance case. Two rungs of eight are finished and a third is a
   * third of the way through — 2.3 of 8 rungs, which counted as rungs is 29%
   * and is wrong by more than a factor of two. The bytes say 70.4%, and the
   * bytes are what the disk is actually doing.
   */
  it("reports 70.4% where counting rungs would say 28.8%", () => {
    const snapshot = progress(
      {
        "2160p": 10.18 * GIB,
        "1440p": 7.31 * GIB,
        "1080p": 1.43 * GIB,
      },
      ["2160p", "1440p"],
      "1080p",
    );

    expect(snapshot.completedBytes / GIB).toBeCloseTo(18.92, 2);
    expect(snapshot.totalBytes / GIB).toBeCloseTo(26.86, 2);
    expect(snapshot.fraction * 100).toBeCloseTo(70.4, 1);

    // The figure a rung count would have produced, stated so the difference is
    // impossible to reintroduce quietly.
    const byRungCount = (2 + 1.43 / 4.76) / 8;
    expect(byRungCount * 100).toBeCloseTo(28.8, 1);
  });

  it("puts each rendition in the right state", () => {
    const snapshot = progress(
      { "2160p": 10.18 * GIB, "1440p": 7.31 * GIB, "1080p": 1.43 * GIB },
      ["2160p", "1440p"],
      "1080p",
    );
    const state = Object.fromEntries(
      snapshot.renditions.map((rendition) => [rendition.id, rendition.state]),
    );
    expect(state["2160p"]).toBe("complete");
    expect(state["1440p"]).toBe("complete");
    expect(state["1080p"]).toBe("running");
    expect(state["720p"]).toBe("waiting");
    expect(state["144p"]).toBe("waiting");
  });

  it("is halfway through the largest rung at 18.9% overall, not at 6.25%", () => {
    // Half of 2160p is 5.09 GiB of 26.86 GiB. Half of one rung of eight would
    // be 6.25%; the bytes say nearly three times that.
    const snapshot = progress({ "2160p": 5.09 * GIB }, [], "2160p");
    expect(snapshot.fraction * 100).toBeCloseTo(18.95, 1);
  });

  it("moves forward across a rendition boundary, never back", () => {
    const before = progress(
      { "2160p": 10.18 * GIB },
      ["2160p"],
      "2160p",
    ).fraction;
    const after = progress(
      { "2160p": 10.18 * GIB },
      ["2160p"],
      "1440p",
    ).fraction;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  /**
   * The denominator is committed before the first byte moves and does not move
   * again. An earlier version substituted each rendition's measured size as it
   * completed, which changed the total during the phase — always downwards, so
   * never a backwards bar, but it meant the number under the bar changed for
   * reasons that had nothing to do with progress.
   */
  it("holds the denominator fixed for the whole phase", () => {
    const committed = 26.86 * GIB;
    const states: Array<AssemblyPhaseProgress> = [
      progress({}, [], "2160p"),
      progress({ "2160p": 5 * GIB }, [], "2160p"),
      // Finished a little short of the estimate: one init segment per epoch.
      progress({ "2160p": 10.18 * GIB - 34 * 1024 }, ["2160p"], "1440p"),
      progress(
        { "2160p": 10.18 * GIB - 34 * 1024, "1440p": 7.31 * GIB - 34 * 1024 },
        ["2160p", "1440p"],
        "1080p",
      ),
    ];
    for (const state of states) {
      expect(state.totalBytes).toBeCloseTo(committed, 0);
    }
  });

  it("reconciles to exactly 100% when every rendition is closed", () => {
    // Every rendition finished a little under its estimate, so the ratio alone
    // would stop just short. The phase is over because the renditions are.
    const written = Object.fromEntries(
      GLADIATOR.map(([id, size]) => [id, size - 34 * 1024]),
    );
    const snapshot = progress(written, IDS);
    expect(snapshot.completedBytes).toBeLessThan(snapshot.totalBytes);
    expect(snapshot.fraction).toBe(1);
  });

  it("never moves backwards or past 100% across a whole assembly", () => {
    const order = IDS;
    const written: Record<string, number> = {};
    const finished: string[] = [];
    let previous = -1;
    for (const id of order) {
      const size = EXPECTED.get(id)!;
      for (const part of [0, 0.25, 0.5, 0.75, 1]) {
        written[id] = size * part;
        const snapshot = progress(written, [...finished], id);
        expect(snapshot.fraction).toBeGreaterThanOrEqual(previous);
        expect(snapshot.fraction).toBeLessThanOrEqual(1);
        previous = snapshot.fraction;
      }
      finished.push(id);
      const closed = progress(written, [...finished], id);
      expect(closed.fraction).toBeGreaterThanOrEqual(previous);
      previous = closed.fraction;
    }
    expect(previous).toBe(1);
  });

  it("reaches exactly 1 when every rendition is written", () => {
    const written = Object.fromEntries(GLADIATOR);
    const snapshot = progress(written, IDS);
    expect(snapshot.fraction).toBe(1);
    expect(snapshot.completedBytes).toBe(snapshot.totalBytes);
  });

  it("reports nothing rather than a nonsense fraction before any work", () => {
    const snapshot = buildAssemblyProgress({
      renditionIds: [],
      expected: new Map(),
      written: new Map(),
      finished: new Set(),
    });
    expect(snapshot.fraction).toBe(0);
    expect(Number.isFinite(snapshot.fraction)).toBe(true);
    expect(snapshot.etaSeconds).toBeUndefined();
  });

  it("offers no estimate until a throughput has been measured", () => {
    const snapshot = progress({ "2160p": 1 * GIB }, [], "2160p");
    expect(snapshot.bytesPerSecond).toBeUndefined();
    expect(snapshot.etaSeconds).toBeUndefined();
  });

  /**
   * The real measured rate from the acceptance run: 15.3 MiB/s with 7.94 GiB
   * left is a little over nine minutes.
   */
  it("estimates the remaining time from the measured rate", () => {
    const snapshot = progress(
      { "2160p": 10.18 * GIB, "1440p": 7.31 * GIB, "1080p": 1.43 * GIB },
      ["2160p", "1440p"],
      "1080p",
      15.3 * 1024 * 1024,
    );
    expect(snapshot.etaSeconds).toBeGreaterThan(500);
    expect(snapshot.etaSeconds).toBeLessThan(560);
  });
});

describe("throughput over a rolling window", () => {
  it("says nothing until the window spans real time", () => {
    const rate = createByteRateEstimator();
    rate.sample(0, 1_000);
    expect(rate.rate(1_000)).toBeUndefined();
    rate.sample(1_000_000, 1_100);
    // A tenth of a second is not a measurement, however many bytes it saw.
    expect(rate.rate(1_100)).toBeUndefined();
  });

  it("measures bytes gained over time passed", () => {
    const rate = createByteRateEstimator();
    rate.sample(0, 0);
    rate.sample(10 * 1024 * 1024, 2_000);
    expect(rate.rate(2_000)).toBeCloseTo(5 * 1024 * 1024, -3);
  });

  it("drops samples that fall out of the window", () => {
    const rate = createByteRateEstimator({ windowMs: 5_000 });
    rate.sample(0, 0);
    // A burst long ago, then a slow stretch: the rate describes the stretch.
    rate.sample(100 * 1024 * 1024, 1_000);
    rate.sample(101 * 1024 * 1024, 7_000);
    rate.sample(102 * 1024 * 1024, 9_000);
    const measured = rate.rate(9_000)!;
    expect(measured).toBeLessThan(2 * 1024 * 1024);
  });

  it("reports no rate at all once the writer has stopped", () => {
    const rate = createByteRateEstimator();
    rate.sample(0, 0);
    rate.sample(10 * 1024 * 1024, 2_000);
    expect(rate.rate(2_500)).toBeDefined();
    // Nothing has been written for six seconds: there is no current rate, and
    // continuing to show the old one would produce an estimate that never ends.
    expect(rate.rate(9_000)).toBeUndefined();
  });

  it("starts a new window when the byte count goes backwards", () => {
    const rate = createByteRateEstimator();
    rate.sample(0, 0);
    rate.sample(10 * 1024 * 1024, 2_000);
    // Assembly restarted after an interruption: the earlier bytes are gone.
    rate.sample(0, 3_000);
    expect(rate.rate(3_000)).toBeUndefined();
  });

  it("never produces Infinity or NaN for a zero-length window", () => {
    const rate = createByteRateEstimator();
    rate.sample(1_000, 1_000);
    rate.sample(2_000, 1_000);
    expect(rate.rate(1_000)).toBeUndefined();
  });
});

describe("estimates and fractions refuse to be nonsense", () => {
  it("gives no estimate without a rate", () => {
    expect(etaFromRate(1_000, undefined)).toBeUndefined();
    expect(etaFromRate(1_000, 0)).toBeUndefined();
    expect(etaFromRate(1_000, -5)).toBeUndefined();
  });

  it("gives no estimate when nothing remains", () => {
    expect(etaFromRate(0, 1_000)).toBeUndefined();
    expect(etaFromRate(-10, 1_000)).toBeUndefined();
  });

  it("clamps a fraction into [0,1] and survives a zero denominator", () => {
    expect(safeFraction(5, 10)).toBe(0.5);
    expect(safeFraction(20, 10)).toBe(1);
    expect(safeFraction(-1, 10)).toBe(0);
    expect(safeFraction(5, 0)).toBe(0);
    expect(safeFraction(Number.NaN, 10)).toBe(0);
  });
});
