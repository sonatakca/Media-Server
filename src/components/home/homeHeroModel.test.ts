import { describe, expect, it } from "vitest";
import {
  HERO_MOTION,
  travelBudgetPxPerFrame,
  travelDurationS,
  offstagePlacement,
  peakTravelPxPerFrame,
  previousIndex,
  pushedBackPlacement,
  queueIndices,
  queueSlots,
  slotPlacement,
  stagePlacement,
} from "./homeHeroModel";

const DESKTOP_SIZES = [
  { width: 1024, height: 700 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
];

describe("the queue", () => {
  it("holds the titles after the one on stage, wrapping, never the stage itself", () => {
    expect(queueIndices(0, 10)).toEqual([1, 2, 3]);
    expect(queueIndices(8, 10)).toEqual([9, 0, 1]);
    expect(queueIndices(1, 3)).toEqual([2, 0]);
    expect(queueIndices(0, 1)).toEqual([]);
  });

  it("goes back one, wrapping", () => {
    expect(previousIndex(0, 5)).toBe(4);
    expect(previousIndex(3, 5)).toBe(2);
  });
});

describe("queue geometry", () => {
  it.each(DESKTOP_SIZES)(
    "keeps each slot at the stage's own shape at $width×$height",
    (stage) => {
      for (const slot of queueSlots(stage)) {
        expect(slot.width / slot.height).toBeCloseTo(
          stage.width / stage.height,
          5,
        );
      }
    },
  );

  it.each(DESKTOP_SIZES)(
    "lays the slots out inside the frame, left to right, apart ($width)",
    (stage) => {
      const slots = queueSlots(stage);
      for (const [index, slot] of slots.entries()) {
        expect(slot.x).toBeGreaterThan(stage.width / 2);
        expect(slot.x + slot.width).toBeLessThanOrEqual(stage.width);
        expect(slot.y + slot.height).toBeLessThan(stage.height);
        const next = slots[index + 1];
        if (next) expect(next.x).toBeGreaterThan(slot.x + slot.width);
      }
    },
  );
});

describe("motion budget", () => {
  // No edge may move more than 32 px between two frames at 60 fps; beyond
  // that, a move stops reading as motion and starts reading as a jump.
  it.each(DESKTOP_SIZES)(
    "lifts any queued title to the stage within budget ($width)",
    (stage) => {
      for (const slot of queueSlots(stage)) {
        const from = slotPlacement(stage, slot);
        const duration = travelDurationS(stage, from, stagePlacement());
        expect(duration).toBeGreaterThanOrEqual(HERO_MOTION.travelS);
        expect(duration).toBeLessThan(1.8);
        const peak = peakTravelPxPerFrame(
          stage,
          from,
          stagePlacement(),
          duration,
        );
        expect(peak).toBeLessThanOrEqual(travelBudgetPxPerFrame(stage) + 1e-9);
      }
    },
  );

  it.each(DESKTOP_SIZES)(
    "recedes and brings newcomers in within budget ($width)",
    (stage) => {
      const slots = queueSlots(stage);
      const budget = travelBudgetPxPerFrame(stage) + 1e-9;
      expect(
        peakTravelPxPerFrame(
          stage,
          stagePlacement(),
          pushedBackPlacement(stage),
          HERO_MOTION.travelS,
        ),
      ).toBeLessThanOrEqual(budget);
      const last = slotPlacement(stage, slots[slots.length - 1]!);
      const entry = travelDurationS(
        stage,
        offstagePlacement(stage),
        last,
        HERO_MOTION.shiftS,
      );
      expect(
        peakTravelPxPerFrame(stage, offstagePlacement(stage), last, entry),
      ).toBeLessThanOrEqual(budget);
    },
  );
});
