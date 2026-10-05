import { describe, expect, it } from "vitest";
import {
  COPY_ROWS,
  HERO_MOTION,
  heroForm,
  TITLE_SCALE,
  queueTitleTransform,
  stageness,
  arrivalPlacement,
  heroLayout,
  liftDurationS,
  sharedDurationS,
  slotPitch,
  travelBudgetPxPerFrame,
  peakTravelPxPerFrame,
  previousIndex,
  pushedBackPlacement,
  queueIndices,
  queueSlots,
  slotPlacement,
  stagePlacement,
  tallFootGradient,
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
  // Beyond the budget a move stops reading as motion and starts reading as a
  // jump; under it, the hero is fast.
  it.each(DESKTOP_SIZES)(
    "lifts from every slot in the same, short time, within budget ($width)",
    (stage) => {
      const duration = liftDurationS(stage);
      expect(duration).toBeGreaterThanOrEqual(HERO_MOTION.travelS);
      expect(duration).toBeLessThan(1);
      for (const slot of queueSlots(stage)) {
        const peak = peakTravelPxPerFrame(
          stage,
          slotPlacement(stage, slot),
          stagePlacement(),
          duration,
        );
        expect(peak).toBeLessThanOrEqual(travelBudgetPxPerFrame(stage) + 1e-9);
      }
    },
  );

  it.each(DESKTOP_SIZES)("recedes within budget ($width)", (stage) => {
    expect(
      peakTravelPxPerFrame(
        stage,
        stagePlacement(),
        pushedBackPlacement(stage),
        liftDurationS(stage),
      ),
    ).toBeLessThanOrEqual(travelBudgetPxPerFrame(stage) + 1e-9);
  });
});

describe("the queue sliding as a row", () => {
  it.each(DESKTOP_SIZES)(
    "lines arrivals up beyond the right edge, a slot apart ($width)",
    (stage) => {
      const first = arrivalPlacement(stage, 0);
      expect(first.x).toBeGreaterThan(stage.width);
      expect(
        arrivalPlacement(stage, 2).x - arrivalPlacement(stage, 1).x,
      ).toBeCloseTo(slotPitch(stage));
      expect(first.y).toBe(queueSlots(stage)[0]!.y);
    },
  );

  // Choosing slot p: the titles after it close up to the head, and p + 1
  // newcomers arrive. On a shared clock no miniature may overlap or pass
  // another at any moment, whichever slot was chosen.
  it.each(DESKTOP_SIZES)(
    "never lets one miniature pass another, whichever slot was chosen ($width)",
    (stage) => {
      const slots = queueSlots(stage);
      for (const chosen of [0, 1, 2]) {
        const staying = slots
          .slice(chosen + 1)
          .map((slot) => slotPlacement(stage, slot));
        const arriving = Array.from({ length: chosen + 1 }, (_, order) =>
          arrivalPlacement(stage, order),
        );
        const from = [...staying, ...arriving];
        const to = slots.map((slot) => slotPlacement(stage, slot));
        const duration = sharedDurationS(
          stage,
          from.map((start, index) => ({ from: start, to: to[index]! })),
          HERO_MOTION.slideS,
          HERO_MOTION.slideEase,
        );
        expect(duration).toBeLessThan(0.9);
        for (let step = 0; step <= 20; step += 1) {
          const progress = step / 20;
          const xs = from.map(
            (start, index) => start.x + (to[index]!.x - start.x) * progress,
          );
          for (let index = 1; index < xs.length; index += 1) {
            expect(xs[index]! - xs[index - 1]!).toBeGreaterThanOrEqual(
              slots[0]!.width,
            );
          }
        }
      }
    },
  );
});

describe("layout", () => {
  it.each(DESKTOP_SIZES)(
    "puts the copy bottom-left, level with the queue, and the title right above it ($width)",
    (stage) => {
      const layout = heroLayout(stage);
      const slots = queueSlots(stage);
      const queueBottom = stage.height - (slots[0]!.y + slots[0]!.height);
      expect(layout.copy.bottom).toBeCloseTo(queueBottom, 5);
      expect(layout.copy.left + layout.copy.width).toBeLessThan(slots[0]!.x);
      expect(layout.title.bottom).toBeGreaterThan(
        layout.copy.bottom + layout.copy.height,
      );
      const titleTop = stage.height - layout.title.bottom - layout.title.height;
      expect(titleTop).toBeGreaterThan(stage.height * 0.2);
      // With the overview open, the risen title still clears the top bar.
      expect(titleTop - layout.overviewLift).toBeGreaterThan(96);
      expect(layout.overviewLift).toBeGreaterThan(layout.overviewHeight);
    },
  );
});

describe("the logo in a miniature", () => {
  it.each(DESKTOP_SIZES)(
    "is far larger than true to scale and sits bottom-left inside the frame ($width)",
    (stage) => {
      const layout = heroLayout(stage);
      const slot = queueSlots(stage)[0]!;
      const slotScale = slot.width / stage.width;
      const move = queueTitleTransform(stage, layout.title);
      // On screen, the logo box in a miniature against the true-scale one.
      expect(move.scale).toBeGreaterThan(TITLE_SCALE.rest * 1.5);
      const onScreenWidth = layout.title.width * move.scale * slotScale;
      expect(onScreenWidth).toBeGreaterThan(slot.width * 0.3);
      expect(onScreenWidth).toBeLessThanOrEqual(slot.width * 0.41);
      const left = layout.title.left + move.x;
      const bottom = layout.title.bottom - move.y;
      expect(left).toBeGreaterThan(0);
      expect(left + layout.title.width * move.scale).toBeLessThanOrEqual(
        stage.width,
      );
      expect(bottom).toBeGreaterThan(0);
      expect(bottom + layout.title.height * move.scale).toBeLessThan(
        stage.height * 0.4,
      );
    },
  );

  it("belongs to the miniature in a slot and to the stage once it nearly fills it", () => {
    expect(stageness(0.12, 0.12)).toBe(0);
    expect(stageness(0.5, 0.12)).toBeGreaterThan(0);
    expect(stageness(0.5, 0.12)).toBeLessThan(1);
    expect(stageness(0.95, 0.12)).toBe(1);
    expect(stageness(1, 0.12)).toBe(1);
  });
});

/** Phones and tablets upright, as their heroes measure above the tab bar. */
const TALL_SIZES = [
  { width: 375, height: 587 },
  { width: 390, height: 764 },
  { width: 430, height: 852 },
  { width: 768, height: 944 },
  { width: 820, height: 1100 },
  { width: 1024, height: 1366 },
];

describe("a tall stage", () => {
  it.each(TALL_SIZES)(
    "is laid out tall at $width×$height, and a desktop stays wide",
    (stage) => {
      expect(heroForm(stage)).toBe("tall");
      expect(heroLayout(stage).form).toBe("tall");
      for (const desktop of DESKTOP_SIZES)
        expect(heroForm(desktop)).toBe("wide");
    },
  );

  it.each(TALL_SIZES)(
    "keeps the queue at the stage's shape, inside the frame, apart ($width)",
    (stage) => {
      const slots = queueSlots(stage);
      for (const [index, slot] of slots.entries()) {
        expect(slot.width / slot.height).toBeCloseTo(
          stage.width / stage.height,
          5,
        );
        expect(slot.x).toBeGreaterThan(0);
        expect(slot.x + slot.width).toBeLessThan(stage.width);
        expect(slot.y).toBeGreaterThan(stage.height / 2);
        const next = slots[index + 1];
        if (next) expect(next.x).toBeGreaterThan(slot.x + slot.width);
      }
    },
  );

  it.each(TALL_SIZES)(
    "stacks the actions under the queue and keeps the title clear of it ($width)",
    (stage) => {
      const layout = heroLayout(stage);
      const [head] = queueSlots(stage);
      const actionsTop =
        stage.height - layout.copy.bottom - COPY_ROWS.actionsPx;
      // The head's progress line and some air sit between them.
      expect(actionsTop).toBeGreaterThanOrEqual(head!.y + head!.height + 20);
      // The facts share the queue's foot; the title rises from above them.
      const factsBottom =
        stage.height -
        layout.copy.bottom -
        COPY_ROWS.actionsPx -
        layout.actionsGap;
      expect(factsBottom).toBeCloseTo(head!.y + head!.height, 5);
      expect(layout.copy.left + layout.factsWidth).toBeLessThan(head!.x);
      expect(layout.title.left + layout.title.width).toBeLessThan(head!.x);
      expect(layout.title.bottom).toBeGreaterThan(
        layout.copy.bottom + layout.copy.height,
      );
    },
  );

  it.each(TALL_SIZES)(
    "gives a title's own page the whole width ($width)",
    (stage) => {
      const layout = heroLayout(stage, { withQueue: false });
      expect(layout.factsWidth).toBe(layout.copy.width);
      expect(layout.title.width).toBeGreaterThanOrEqual(
        heroLayout(stage).title.width,
      );
    },
  );

  it.each(TALL_SIZES)(
    "rests its title at full size, and sets a phone's actions compact ($width)",
    (stage) => {
      const layout = heroLayout(stage);
      expect(layout.titleScale.rest).toBe(1);
      expect(layout.actions).toBe(stage.width < 600 ? "compact" : "full");
    },
  );

  it.each(TALL_SIZES)(
    "lifts a miniature to the stage within the frame budget ($width)",
    (stage) => {
      const duration = liftDurationS(stage);
      for (const slot of queueSlots(stage)) {
        expect(
          peakTravelPxPerFrame(
            stage,
            slotPlacement(stage, slot),
            stagePlacement(),
            duration,
          ),
        ).toBeLessThanOrEqual(travelBudgetPxPerFrame(stage) + 1e-6);
      }
    },
  );

  it.each(TALL_SIZES)(
    "sinks the poster to solid by the top of the logo's box ($width)",
    (stage) => {
      const { title } = heroLayout(stage);
      const stops = [
        ...tallFootGradient(stage, title).matchAll(/([\d.]+)%/g),
      ].map((match) => Number(match[1]) / 100);
      const solidAt = stops[stops.length - 1]!;
      expect(solidAt).toBeLessThanOrEqual(
        1 - (title.bottom + title.height) / stage.height + 1e-3,
      );
      // The top of the poster, where the faces are, stays clear.
      expect(stops[1]).toBeGreaterThanOrEqual(0.25);
      expect([...stops].sort((a, b) => a - b)).toEqual(stops);
    },
  );
});
