import { describe, expect, it } from "vitest";
import {
  monotonicProgress,
  overallProgress,
  PROCESSING_STAGES,
  stageIndex,
} from "./stages";

describe("overallProgress", () => {
  it("starts at zero and ends at one", () => {
    expect(overallProgress("waiting", 0)).toBe(0);
    expect(overallProgress("complete", 1)).toBe(1);
  });

  it("never goes down as the job moves through its stages", () => {
    let previous = -1;
    for (const stage of PROCESSING_STAGES) {
      const value = overallProgress(stage, 0);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  /**
   * Encoding takes minutes and publishing takes milliseconds. Weighting stages
   * equally would park the bar for the whole encode and then jump it.
   */
  it("gives the video encode most of the bar", () => {
    const videoStart = overallProgress("video", 0);
    const videoEnd = overallProgress("video", 1);

    expect(videoEnd - videoStart).toBeGreaterThan(0.5);
  });

  it("advances within a stage in proportion to that stage", () => {
    expect(overallProgress("video", 0.5)).toBeGreaterThan(
      overallProgress("video", 0),
    );
    expect(overallProgress("video", 0.5)).toBeLessThan(
      overallProgress("video", 1),
    );
  });

  it("clamps a stage progress that arrives out of range", () => {
    expect(overallProgress("video", -1)).toBe(overallProgress("video", 0));
    expect(overallProgress("video", 5)).toBe(overallProgress("video", 1));
  });

  it("counts a skipped stage as done rather than stalling", () => {
    // A source with no subtitles still passes through the subtitles stage.
    expect(overallProgress("packaging", 0)).toBeGreaterThan(
      overallProgress("subtitles", 1) - 0.0001,
    );
  });

  it("orders the stages the way the timeline shows them", () => {
    expect(stageIndex("analysing")).toBeLessThan(stageIndex("video"));
    expect(stageIndex("validating")).toBeLessThan(stageIndex("publishing"));
  });
});

describe("monotonicProgress", () => {
  /**
   * FFmpeg re-reports a lower timestamp after a seek and a stage restarts on
   * retry. A bar that goes backwards reads as a fault even when nothing is
   * wrong, so the stored value is a high-water mark.
   */
  it("never moves backwards", () => {
    expect(monotonicProgress(0.6, 0.4)).toBe(0.6);
    expect(monotonicProgress(0.6, 0.7)).toBe(0.7);
  });

  it("clamps values from outside the range", () => {
    expect(monotonicProgress(0.5, 2)).toBe(1);
    expect(monotonicProgress(0.5, -3)).toBe(0.5);
    expect(monotonicProgress(0, -3)).toBe(0);
  });
});
