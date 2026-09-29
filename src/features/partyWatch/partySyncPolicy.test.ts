import { describe, expect, it } from "vitest";
import {
  catchUpLeadMs,
  driftCorrection,
  groupTarget,
  nextSeekCostMs,
  PARTY_SYNC_TUNING as tuning,
} from "./partySyncPolicy";

describe("where the group wants a player", () => {
  it("stays put while the group is paused", () => {
    expect(
      groupTarget(
        { intent: "paused", hold: null, positionMs: 30_000, anchorMs: 0 },
        99_999,
      ),
    ).toEqual({ advancing: false, positionMs: 30_000, startsInMs: 0 });
  });

  it("stays put while the group waits for someone", () => {
    const target = groupTarget(
      {
        intent: "playing",
        hold: { reason: "buffering", waitingFor: ["a"] },
        positionMs: 30_000,
        anchorMs: 0,
      },
      99_999,
    );
    expect(target.advancing).toBe(false);
    expect(target.positionMs).toBe(30_000);
  });

  it("counts down to a scheduled start, then advances from it", () => {
    const snapshot = {
      intent: "playing" as const,
      hold: null,
      positionMs: 30_000,
      anchorMs: 10_000,
    };
    expect(groupTarget(snapshot, 9_700)).toEqual({
      advancing: true,
      positionMs: 30_000,
      startsInMs: 300,
    });
    expect(groupTarget(snapshot, 12_500)).toEqual({
      advancing: true,
      positionMs: 32_500,
      startsInMs: 0,
    });
  });
});

describe("drift correction", () => {
  it("leaves imperceptible drift alone", () => {
    expect(driftCorrection(100, false)).toEqual({ kind: "none" });
    expect(driftCorrection(-100, false)).toEqual({ kind: "none" });
  });

  it("runs a player that is behind slightly fast, and one ahead slightly slow", () => {
    const behind = driftCorrection(-400, false);
    const ahead = driftCorrection(400, false);
    expect(behind.kind).toBe("rate");
    expect(ahead.kind).toBe("rate");
    if (behind.kind === "rate" && ahead.kind === "rate") {
      expect(behind.rate).toBeGreaterThan(1);
      expect(ahead.rate).toBeLessThan(1);
      expect(Math.abs(behind.rate - 1)).toBeLessThanOrEqual(
        tuning.maxRateDelta,
      );
    }
  });

  it("keeps correcting until well inside the start threshold", () => {
    // 80 ms would not start a correction, but does not end one either.
    expect(driftCorrection(80, false).kind).toBe("none");
    expect(driftCorrection(80, true).kind).toBe("rate");
    expect(driftCorrection(30, true).kind).toBe("none");
  });

  it("never changes speed by more than a few percent", () => {
    const correction = driftCorrection(-990, false);
    expect(correction.kind).toBe("rate");
    if (correction.kind === "rate") {
      expect(correction.rate).toBeGreaterThan(1.04);
      expect(correction.rate).toBeLessThanOrEqual(1 + tuning.maxRateDelta);
    }
    const small = driftCorrection(-130, false);
    expect(small).toEqual({ kind: "rate", rate: 1 + tuning.minRateDelta });
  });

  it("seeks when the drift is too large to close by speed", () => {
    expect(driftCorrection(-1_000, true)).toEqual({ kind: "seek" });
    expect(driftCorrection(4_000, false)).toEqual({ kind: "seek" });
  });
});

describe("catching up", () => {
  it("lands further ahead when seeks here are slow", () => {
    expect(catchUpLeadMs(400)).toBe(tuning.catchUpLeadMinMs);
    expect(catchUpLeadMs(2_000)).toBe(3_000);
    expect(catchUpLeadMs(60_000)).toBe(tuning.catchUpLeadMaxMs);
  });

  it("learns seek cost mostly from the latest seek", () => {
    expect(nextSeekCostMs(1_000, 3_000)).toBe(2_200);
  });
});
