/**
 * The one bar that spans a whole job.
 *
 * Its properties matter more than its exact position: it must never go
 * backwards, never fill before the package is published, and never sit still
 * while real work is happening. These tests assert those properties directly,
 * because they are what an operator relies on when deciding whether a job needs
 * attention.
 */

import { describe, expect, it } from "vitest";
import {
  GLOBAL_PHASES,
  globalPhaseFor,
  globalProgress,
  monotonic,
  planPhaseWeights,
  type GlobalPhase,
} from "./jobProgress";

const GIB = 1024 ** 3;

/** Gladiator: two hours fifty, three audio tracks, a 27 GB ladder. */
const GLADIATOR = {
  sourceDurationSeconds: 170 * 60,
  audioTrackCount: 3,
  subtitleTrackCount: 2,
  outputBytes: 26.86 * GIB,
};

describe("phase weights come from the job's own plan", () => {
  it("gives video the overwhelming share of a feature-length encode", () => {
    const weights = planPhaseWeights(GLADIATOR);
    const total = GLOBAL_PHASES.reduce((sum, phase) => sum + weights[phase], 0);
    expect(weights.encoding / total).toBeGreaterThan(0.8);
  });

  /**
   * Two titles of the same length whose ladders differ in size must differ in
   * how much of the bar assembly gets. A fixed table cannot express that, which
   * is the whole reason the weights are planned per job.
   */
  it("gives a bigger ladder a bigger share of assembly", () => {
    const small = planPhaseWeights({ ...GLADIATOR, outputBytes: 2 * GIB });
    const large = planPhaseWeights({ ...GLADIATOR, outputBytes: 40 * GIB });
    const share = (weights: ReturnType<typeof planPhaseWeights>) => {
      const total = GLOBAL_PHASES.reduce(
        (sum, phase) => sum + weights[phase],
        0,
      );
      return weights.assembling / total;
    };
    expect(share(large)).toBeGreaterThan(share(small));
  });

  it("gives more audio tracks more of the bar", () => {
    const one = planPhaseWeights({ ...GLADIATOR, audioTrackCount: 1 });
    const five = planPhaseWeights({ ...GLADIATOR, audioTrackCount: 5 });
    expect(five.audio).toBeGreaterThan(one.audio);
  });

  it("never gives a phase zero width, even with nothing to do", () => {
    const weights = planPhaseWeights({
      sourceDurationSeconds: 0,
      audioTrackCount: 0,
      subtitleTrackCount: 0,
      outputBytes: 0,
    });
    for (const phase of GLOBAL_PHASES) {
      expect(weights[phase]).toBeGreaterThan(0);
    }
  });
});

describe("the global bar", () => {
  const weights = planPhaseWeights(GLADIATOR);
  const at = (phase: GlobalPhase, fraction: number) =>
    globalProgress(weights, phase, fraction);

  it("advances as a phase advances", () => {
    expect(at("encoding", 0.5)).toBeGreaterThan(at("encoding", 0.25));
    expect(at("assembling", 0.9)).toBeGreaterThan(at("assembling", 0.1));
  });

  /**
   * The property the old model broke every time a phase changed: the bar reset
   * to the start of the new phase's own scale. Here the end of one phase and
   * the start of the next are the same position.
   */
  it("hands over between phases without a jump in either direction", () => {
    for (let index = 0; index < GLOBAL_PHASES.length - 1; index += 1) {
      const ending = GLOBAL_PHASES[index]!;
      const starting = GLOBAL_PHASES[index + 1]!;
      expect(at(starting, 0)).toBeCloseTo(at(ending, 1), 10);
    }
  });

  it("runs through the whole pipeline without ever going backwards", () => {
    const walk: Array<[GlobalPhase, number]> = [];
    for (const phase of GLOBAL_PHASES) {
      for (const fraction of [0, 0.1, 0.5, 0.9, 1]) {
        walk.push([phase, fraction]);
      }
    }
    let previous = -1;
    for (const [phase, fraction] of walk) {
      const value = at(phase, fraction);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("stays below the end even when the last phase reports complete", () => {
    // Publication finishing is not the same fact as the job row saying it
    // succeeded, and only the second one may fill the bar.
    expect(at("publishing", 1)).toBeLessThan(1);
    expect(at("publishing", 1)).toBeGreaterThan(0.99);
  });

  it("is a sliver, not three per cent, once analysis is done", () => {
    // The old stage table put a four-hour job at 2% for having probed its
    // source. The work is seconds; the bar should say so.
    expect(at("analysing", 1)).toBeLessThan(0.005);
  });

  it("clamps a fraction that arrives outside [0,1]", () => {
    expect(at("encoding", -1)).toBe(at("encoding", 0));
    expect(at("encoding", 5)).toBe(at("encoding", 1));
  });

  it("survives a plan with no measurable work at all", () => {
    const empty = planPhaseWeights({
      sourceDurationSeconds: 0,
      audioTrackCount: 0,
      subtitleTrackCount: 0,
      outputBytes: 0,
    });
    const value = globalProgress(empty, "encoding", 0.5);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(1);
  });
});

describe("the high-water mark", () => {
  it("keeps the larger of two values", () => {
    expect(monotonic(0.5, 0.4)).toBe(0.5);
    expect(monotonic(0.5, 0.6)).toBe(0.6);
  });

  /**
   * A retried epoch reports a lower media position than the attempt before it,
   * and an assembly that restarted after an interruption reports zero bytes.
   * Neither may drag the bar backwards — and neither is allowed to be described
   * as still complete either, which is why the phase panels below the bar show
   * the real, lower figures while the bar holds.
   */
  it("holds through a phase restarting from nothing", () => {
    const weights = planPhaseWeights(GLADIATOR);
    let bar = 0;
    bar = monotonic(bar, globalProgress(weights, "assembling", 0.7));
    const beforeInterruption = bar;
    bar = monotonic(bar, globalProgress(weights, "assembling", 0));
    expect(bar).toBe(beforeInterruption);
  });

  it("refuses values outside [0,1]", () => {
    expect(monotonic(0, 2)).toBe(1);
    expect(monotonic(0, -1)).toBe(0);
    expect(monotonic(0.4, Number.NaN)).toBe(0.4);
  });
});

describe("build phases map onto the bar's phases", () => {
  it("names one bar phase for every build phase", () => {
    const phases = [
      "planning",
      "encoding",
      "audio",
      "subtitles",
      "assembling",
      "validating",
      "publishing",
    ] as const;
    for (const phase of phases) {
      expect(GLOBAL_PHASES).toContain(globalPhaseFor(phase));
    }
  });
});
