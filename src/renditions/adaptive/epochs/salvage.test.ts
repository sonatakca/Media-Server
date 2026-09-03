/**
 * The salvage data model, which everything else is built on.
 *
 * The property that matters most is the tiling: the ranges handed to the audio
 * stage and the subtitle extractor must cover the source exactly once, in
 * order, with no gap and no overlap. Anything else moves material after a hole
 * off its own timeline, which is the one outcome salvage exists to prevent.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOURCE_DAMAGE_POLICY,
  damagedSeconds,
  describeInterval,
  formatIntervalClock,
  isSourceDamagePolicy,
  intervalContains,
  mergeIntervals,
  planSourceRanges,
  sourceDamagePolicyFromEnvironment,
} from "./salvage";

describe("the policy", () => {
  it("is strict unless a deployment says otherwise", () => {
    expect(DEFAULT_SOURCE_DAMAGE_POLICY).toBe("fail");
    expect(sourceDamagePolicyFromEnvironment({})).toBe("fail");
  });

  it("reads an explicit choice from the environment", () => {
    expect(
      sourceDamagePolicyFromEnvironment({
        SEYIRLIK_SOURCE_DAMAGE_POLICY: "replace-epoch",
      }),
    ).toBe("replace-epoch");
  });

  it("falls back to strict rather than failing on a typo", () => {
    expect(
      sourceDamagePolicyFromEnvironment({
        SEYIRLIK_SOURCE_DAMAGE_POLICY: "replace-epochs",
      }),
    ).toBe("fail");
    expect(isSourceDamagePolicy("replace-epochs")).toBe(false);
  });
});

describe("mergeIntervals", () => {
  it("joins two damaged epochs into one hole", () => {
    expect(
      mergeIntervals([
        { startSeconds: 3000, endSeconds: 3300 },
        { startSeconds: 3300, endSeconds: 3600 },
      ]),
    ).toEqual([{ startSeconds: 3000, endSeconds: 3600 }]);
  });

  it("orders them and drops anything empty or backwards", () => {
    expect(
      mergeIntervals([
        { startSeconds: 100, endSeconds: 200 },
        { startSeconds: 10, endSeconds: 10 },
        { startSeconds: 50, endSeconds: 40 },
        { startSeconds: 5, endSeconds: 9 },
      ]),
    ).toEqual([
      { startSeconds: 5, endSeconds: 9 },
      { startSeconds: 100, endSeconds: 200 },
    ]);
  });
});

describe("planSourceRanges", () => {
  it("tiles the whole timeline exactly once, in order", () => {
    const total = 9039.2;
    const ranges = planSourceRanges(
      [{ startSeconds: 3000.039, endSeconds: 3300.005 }],
      total,
    );
    expect(ranges.map((range) => range.kind)).toEqual([
      "source",
      "synthetic",
      "source",
    ]);
    expect(ranges[0]!.startSeconds).toBe(0);
    expect(ranges[ranges.length - 1]!.endSeconds).toBe(total);
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]!.startSeconds).toBe(ranges[index - 1]!.endSeconds);
    }
    const covered = ranges.reduce(
      (sum, range) => sum + range.durationSeconds,
      0,
    );
    expect(covered).toBeCloseTo(total, 6);
  });

  it("gives the synthetic range exactly the damaged length", () => {
    const [, hole] = planSourceRanges(
      [{ startSeconds: 3000.039, endSeconds: 3300.005 }],
      9039.2,
    );
    expect(hole!.durationSeconds).toBeCloseTo(299.966, 6);
  });

  it("handles a hole at the very beginning without an empty range", () => {
    const ranges = planSourceRanges(
      [{ startSeconds: 0, endSeconds: 300 }],
      900,
    );
    expect(ranges.map((range) => range.kind)).toEqual(["synthetic", "source"]);
  });

  it("handles a hole running to the end", () => {
    const ranges = planSourceRanges(
      [{ startSeconds: 600, endSeconds: 900 }],
      900,
    );
    expect(ranges.map((range) => range.kind)).toEqual(["source", "synthetic"]);
    expect(ranges[1]!.endSeconds).toBe(900);
  });

  it("is the identity tiling when nothing is damaged", () => {
    const ranges = planSourceRanges([], 900);
    expect(ranges).toEqual([
      {
        startSeconds: 0,
        endSeconds: 900,
        durationSeconds: 900,
        kind: "source",
      },
    ]);
  });

  it("clamps a hole that runs past the end of the source", () => {
    const ranges = planSourceRanges(
      [{ startSeconds: 800, endSeconds: 5000 }],
      900,
    );
    expect(ranges[ranges.length - 1]!.endSeconds).toBe(900);
  });
});

describe("describing an interval", () => {
  it("names the minutes the way the incident report does", () => {
    expect(describeInterval({ startSeconds: 3000, endSeconds: 3300 })).toBe(
      "00:50:00–00:55:00",
    );
    expect(formatIntervalClock(-1)).toBe("--:--:--");
  });

  it("totals what was replaced without counting an overlap twice", () => {
    expect(
      damagedSeconds([
        { startSeconds: 3000, endSeconds: 3300 },
        { startSeconds: 3100, endSeconds: 3400 },
      ]),
    ).toBe(400);
  });

  it("knows whether a moment is inside a hole", () => {
    const holes = [{ startSeconds: 3000, endSeconds: 3300 }];
    expect(intervalContains(holes, 3123)).toBe(true);
    expect(intervalContains(holes, 3300)).toBe(false);
  });
});
