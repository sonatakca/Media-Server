/**
 * The rules that decide where a dragged queue card lands.
 *
 * These are asserted on their own because they are what the operator is
 * actually looking at during a drag: the list only tells the truth about the
 * drop if the slot it opens and the order it would save are the same answer.
 * The heights here are deliberately unequal — processing cards carry different
 * amounts of detail, and a model that only works on a list of identical rows
 * would be wrong on the real page.
 */

import { describe, expect, it } from "vitest";
import {
  MAGNET_GIVE,
  edgeScrollVelocity,
  measureGap,
  planQueueDrag,
  type SortableRect,
} from "./queueDragModel";

/** Four rows of different heights, laid out with an 8px gap between them. */
function layout(heights: readonly number[]): SortableRect[] {
  const rects: SortableRect[] = [];
  let top = 100;
  heights.forEach((height, index) => {
    rects.push({ id: String.fromCharCode(97 + index), top, height });
    top += height + 8;
  });
  return rects;
}

const EVEN = layout([100, 100, 100, 100]);
const UNEVEN = layout([60, 180, 90, 140]);

/** The order a release would commit, for a card dragged this far. */
function orderAfter(
  rects: readonly SortableRect[],
  id: string,
  offsetY: number,
): string[] {
  return planQueueDrag(rects, id, offsetY)!.order;
}

describe("reading the list's own geometry", () => {
  it("takes the gap from the rows rather than from a constant", () => {
    expect(measureGap(EVEN)).toBe(8);
    expect(measureGap(UNEVEN)).toBe(8);
  });

  it("has no gap to read in a list of one", () => {
    expect(measureGap(EVEN.slice(0, 1))).toBe(0);
  });
});

describe("where a dragged card would land", () => {
  it("stays put until the card has passed half of its neighbour", () => {
    // Slot 1's centre is one row-and-gap below slot 0's: 108px.
    expect(orderAfter(EVEN, "a", 50)).toEqual(["a", "b", "c", "d"]);
    expect(orderAfter(EVEN, "a", 60)).toEqual(["b", "a", "c", "d"]);
  });

  it("walks one place down at a time as the card keeps moving", () => {
    expect(orderAfter(EVEN, "a", 110)).toEqual(["b", "a", "c", "d"]);
    expect(orderAfter(EVEN, "a", 220)).toEqual(["b", "c", "a", "d"]);
    expect(orderAfter(EVEN, "a", 330)).toEqual(["b", "c", "d", "a"]);
  });

  it("takes the last row to the front", () => {
    expect(orderAfter(EVEN, "d", -330)).toEqual(["d", "a", "b", "c"]);
  });

  it("goes no further than the ends of the list", () => {
    expect(orderAfter(EVEN, "a", 5000)).toEqual(["b", "c", "d", "a"]);
    expect(orderAfter(EVEN, "d", -5000)).toEqual(["d", "a", "b", "c"]);
  });

  it("leaves the order alone when the card is put back where it was", () => {
    const plan = planQueueDrag(EVEN, "b", 0)!;
    expect(plan.order).toEqual(["a", "b", "c", "d"]);
    expect(plan.index).toBe(1);
    expect(plan.shifts.size).toBe(0);
    expect(plan.activeSlotOffset).toBe(0);
  });

  it("knows nothing about a row that is not in the list", () => {
    expect(planQueueDrag(EVEN, "zz", 40)).toBeNull();
  });
});

describe("cards of different heights", () => {
  it("measures a short card against the tall one it is passing", () => {
    // `a` is 60 tall; `b` below it is 180. Its slot moves 188px, so the
    // switch belongs at 94 — not at half of `a`'s own height.
    expect(orderAfter(UNEVEN, "a", 80)).toEqual(["a", "b", "c", "d"]);
    expect(orderAfter(UNEVEN, "a", 100)).toEqual(["b", "a", "c", "d"]);
  });

  it("measures a tall card against the short one above it", () => {
    // `b` is 180 tall and `a` above it is 60: its slot moves by 68px.
    expect(orderAfter(UNEVEN, "b", -30)).toEqual(["a", "b", "c", "d"]);
    expect(orderAfter(UNEVEN, "b", -40)).toEqual(["b", "a", "c", "d"]);
  });

  it("opens exactly the gap the held card needs", () => {
    const plan = planQueueDrag(UNEVEN, "a", 100)!;
    // `b` moves up by `a`'s height and the gap; `a`'s own slot is where `b`
    // was. Nothing below the disturbed pair moves at all.
    expect(plan.shifts.get("b")).toBe(-68);
    expect(plan.shifts.has("c")).toBe(false);
    expect(plan.shifts.has("d")).toBe(false);
    expect(plan.activeSlotOffset).toBe(188);
  });

  it("returns the same answer for the same pointer, wherever it came from", () => {
    // The plan is a function of how far the card has moved and nothing else,
    // which is what a row resting on a boundary depends on: there is no
    // previous answer for the next one to disagree with.
    const approaching = planQueueDrag(UNEVEN, "a", 99.6)!.order;
    const leaving = planQueueDrag(UNEVEN, "a", 99.6)!.order;
    expect(approaching).toEqual(leaving);
    for (let offset = 0; offset < 400; offset += 3) {
      const here = planQueueDrag(UNEVEN, "a", offset)!.index;
      const there = planQueueDrag(UNEVEN, "a", offset + 3)!.index;
      // Monotone: the target index never doubles back while the card
      // continues in one direction.
      expect(there).toBeGreaterThanOrEqual(here);
    }
  });
});

/**
 * Where the card is *drawn*, as opposed to where it would land.
 *
 * This is the half of the gesture the operator complained about. The old
 * implementation drew the card wherever the pointer had dragged it, so the
 * list would open a gap in one place and the card would hang in another —
 * usually across the title of the row below. These assertions are about the
 * card being in the slot the list has opened for it.
 */
describe("the card's own position under the pointer", () => {
  /** Where the card's slot sits, for the plan a given pointer offset makes. */
  function slotOffsetAt(
    rects: readonly SortableRect[],
    id: string,
    offsetY: number,
  ): number {
    return planQueueDrag(rects, id, offsetY)!.activeSlotOffset;
  }

  it("rests exactly in its slot when the pointer is on one", () => {
    // Every offset that *is* a slot: the card is drawn in it, not near it.
    for (const offset of [0, 188, 286, 434]) {
      const plan = planQueueDrag(UNEVEN, "a", offset)!;
      expect(plan.magneticOffset).toBeCloseTo(plan.activeSlotOffset, 6);
    }
  });

  it("is drawn nearer its slot than the bare pointer would put it", () => {
    for (let offset = 0; offset <= 434; offset += 7) {
      const plan = planQueueDrag(UNEVEN, "a", offset)!;
      const magnet = Math.abs(plan.magneticOffset - plan.activeSlotOffset);
      const bare = Math.abs(plan.boundedOffset - plan.activeSlotOffset);
      expect(magnet).toBeLessThanOrEqual(bare + 1e-9);
    }
  });

  it("never strays further from its slot than the magnet allows", () => {
    /*
     * The guarantee the whole thing rests on. These cards are the width of the
     * page and carry three rows of statistics; a card drawn even a third of
     * the way into its neighbour puts two sets of numbers on top of each other
     * and neither of them can be read. Holding the card to its own slot is
     * what keeps every frame of the gesture legible.
     */
    for (const rects of [EVEN, UNEVEN]) {
      for (const id of ["a", "b", "c", "d"]) {
        for (let offset = -600; offset <= 600; offset += 1) {
          const plan = planQueueDrag(rects, id, offset)!;
          expect(
            Math.abs(plan.magneticOffset - plan.activeSlotOffset),
          ).toBeLessThanOrEqual(MAGNET_GIVE + 1e-9);
        }
      }
    }
  });

  it("answers a small movement of the pointer honestly", () => {
    // Held to its slot is not the same as nailed to it. Inside the give, a
    // pixel of pointer is very nearly a pixel of card, so the card reads as
    // something being carried rather than as something that has stuck.
    const still = planQueueDrag(UNEVEN, "a", 0)!.magneticOffset;
    const nudged = planQueueDrag(UNEVEN, "a", 4)!.magneticOffset;
    expect(nudged - still).toBeGreaterThan(3);
    expect(nudged - still).toBeLessThanOrEqual(4);
  });

  it("moves only the way the pointer is moving", () => {
    // No doubling back: a card cannot appear to retreat while the hand
    // holding it keeps going, which is the shape a jittering list takes.
    let previous = planQueueDrag(UNEVEN, "a", -50)!.magneticOffset;
    for (let offset = -49; offset <= 480; offset += 1) {
      const here = planQueueDrag(UNEVEN, "a", offset)!.magneticOffset;
      expect(here).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = here;
    }
  });

  it("changes by a whole slot, and only where the slot changes", () => {
    /*
     * The one place the drawn position moves more than the pointer did: the
     * card leaves one slot for the next. `useQueueSortable` draws it with the
     * same transition the rows making room use, so what this step describes is
     * the card settling into the gap rather than appearing in it.
     */
    let previous = planQueueDrag(UNEVEN, "a", 0)!;
    const steps: number[] = [];
    for (let offset = 1; offset <= 480; offset += 1) {
      const here = planQueueDrag(UNEVEN, "a", offset)!;
      const moved = Math.abs(here.magneticOffset - previous.magneticOffset);
      if (here.index !== previous.index) steps.push(moved);
      // Everywhere else the card moves no faster than the pointer.
      else expect(moved).toBeLessThanOrEqual(1 + 1e-9);
      previous = here;
    }
    // Three boundaries in a list of four, each crossed exactly once.
    expect(steps).toHaveLength(3);
    for (const step of steps) expect(step).toBeGreaterThan(MAGNET_GIVE);
  });

  it("stays inside the list however far the pointer goes past the end", () => {
    const last = planQueueDrag(UNEVEN, "a", 10_000)!;
    expect(last.magneticOffset).toBeCloseTo(slotOffsetAt(UNEVEN, "a", 10_000));
    const first = planQueueDrag(UNEVEN, "d", -10_000)!;
    expect(first.magneticOffset).toBeCloseTo(
      slotOffsetAt(UNEVEN, "d", -10_000),
    );
  });

  it("holds a card of even height to its slots just the same", () => {
    for (const offset of [0, 108, 216, 324]) {
      const plan = planQueueDrag(EVEN, "a", offset)!;
      expect(plan.magneticOffset).toBeCloseTo(plan.activeSlotOffset, 6);
    }
  });
});

describe("scrolling at the edges", () => {
  it("does nothing in the middle of the viewport", () => {
    expect(edgeScrollVelocity(400, 900)).toBe(0);
  });

  it("pulls upwards near the top and downwards near the bottom", () => {
    expect(edgeScrollVelocity(10, 900)).toBeLessThan(0);
    expect(edgeScrollVelocity(895, 900)).toBeGreaterThan(0);
  });

  it("speeds up as the card approaches the edge", () => {
    expect(Math.abs(edgeScrollVelocity(20, 900))).toBeGreaterThan(
      Math.abs(edgeScrollVelocity(80, 900)),
    );
  });

  it("stays still in a viewport too short to have edges", () => {
    expect(edgeScrollVelocity(10, 100)).toBe(0);
  });
});

/**
 * The same gesture carrying several rows at once.
 *
 * A block is the general case and a single row is the degenerate one, so
 * everything above is also a test of this: what is asserted here is only what
 * a block does that one row cannot — gather, stay under the cursor, and open a
 * gap the size of itself.
 */
describe("dragging a block of rows", () => {
  const rects = [
    { id: "a", top: 0, height: 100 },
    { id: "b", top: 108, height: 100 },
    { id: "c", top: 216, height: 100 },
    { id: "d", top: 324, height: 100 },
  ];

  it("carries the chosen rows in the order the list has them", () => {
    // Chosen in the wrong order on purpose: "c" was ticked first, and the
    // block still reads a, c — the queue's arrangement, not the operator's
    // clicking.
    const plan = planQueueDrag(rects, ["c", "a"], 0, "a")!;
    expect(plan.order).toEqual(["a", "c", "b", "d"]);
  });

  it("gathers the block under the row the pointer is holding", () => {
    // Picked up by "c", so "c" does not move and "a" comes to sit above it.
    const plan = planQueueDrag(rects, ["a", "c"], 0, "c")!;
    expect(plan.memberAnchors.get("c")).toBe(0);
    // "a" is drawn one row above "c" — that is, 108px below where it lives.
    expect(plan.memberAnchors.get("a")).toBe(108);
  });

  it("opens a gap the height of the whole block", () => {
    // Two rows and the gap between them, moved to the end of the list.
    const plan = planQueueDrag(rects, ["a", "b"], 400, "a")!;
    expect(plan.order).toEqual(["c", "d", "a", "b"]);
    // "c" and "d" come up by both rows and both gaps: what closes behind a
    // block is the space it occupied in the list, not the height of its cards.
    expect(plan.shifts.get("c")).toBe(-216);
    expect(plan.shifts.get("d")).toBe(-216);
  });

  it("reads a block of one exactly as it reads a single row", () => {
    const one = planQueueDrag(rects, ["b"], 120)!;
    const same = planQueueDrag(rects, "b", 120)!;
    expect(one.order).toEqual(same.order);
    expect(one.index).toBe(same.index);
    expect(one.activeSlotOffset).toBe(same.activeSlotOffset);
    expect(one.memberAnchors.get("b")).toBe(0);
  });

  it("says nothing about a selection the list does not hold", () => {
    expect(planQueueDrag(rects, ["gone"], 0)).toBeNull();
  });
});
