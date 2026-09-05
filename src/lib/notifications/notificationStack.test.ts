import { describe, expect, it } from "vitest";
import { planNotificationStack } from "./notificationStack";
import type { SeyirlikNotification } from "./notificationStore";

function feed(count: number): SeyirlikNotification[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `n${index}`,
    tone: "info" as const,
    title: `Entry ${index}`,
    life: "short" as const,
    createdAt: 1_000 - index,
  }));
}

describe("laying out the notification column", () => {
  it("lists everything plainly while under the limit", () => {
    const stack = planNotificationStack(feed(2), 3);

    expect(stack.entries).toHaveLength(2);
    expect(stack.entries.every((entry) => !entry.isCollapsed)).toBe(true);
    expect(stack.entries.every((entry) => entry.offsetY === 0)).toBe(true);
    expect(stack.hiddenCount).toBe(0);
  });

  it("puts the earliest at the front and stacks later ones in behind it", () => {
    // The store keeps the newest at the head of its list; the column is read
    // the other way round, so the card already being read holds its place and
    // whatever arrives next goes under it rather than taking its position.
    const stack = planNotificationStack(feed(3), 3);
    expect(stack.entries.map((entry) => entry.notification.title)).toEqual([
      "Entry 2",
      "Entry 1",
      "Entry 0",
    ]);
  });

  it("buries the newest rather than the oldest once the pile is deep", () => {
    // feed() counts down from the newest, so "Entry 0" is the latest arrival
    // and belongs at the very back.
    const shown = planNotificationStack(feed(6), 1).entries.map(
      (entry) => entry.notification.title,
    );
    expect(shown).toEqual(["Entry 5", "Entry 4", "Entry 3"]);
  });

  it("paints the card at the front over the pile behind it", () => {
    const stack = planNotificationStack(feed(4), 3);
    const depths = stack.entries.map((entry) => entry.zIndex);
    expect(depths).toEqual([...depths].sort((a, b) => b - a));
  });

  it("collapses the overflow into a pile you can see the depth of", () => {
    const stack = planNotificationStack(feed(5), 3);

    const collapsed = stack.entries.filter((entry) => entry.isCollapsed);
    expect(collapsed).toHaveLength(2);
    // Each step back is higher, smaller and dimmer, which is what reads as depth.
    expect(collapsed[0]?.offsetY).toBeGreaterThan(
      collapsed[1]?.offsetY as number,
    );
    expect(collapsed[0]?.scale).toBeGreaterThan(collapsed[1]?.scale as number);
    expect(collapsed[0]?.opacity).toBeGreaterThan(
      collapsed[1]?.opacity as number,
    );
  });

  it("stops peeking after a couple, and counts the rest", () => {
    // Beyond two the cards behind are indistinguishable, so they become a
    // number instead of more geometry.
    const stack = planNotificationStack(feed(9), 3);

    expect(stack.entries).toHaveLength(5);
    expect(stack.hiddenCount).toBe(4);
  });

  it("never reports a negative hidden count", () => {
    expect(planNotificationStack(feed(1), 3).hiddenCount).toBe(0);
    expect(planNotificationStack([], 3).hiddenCount).toBe(0);
  });

  it("keeps at least one card expanded however the limit is set", () => {
    const stack = planNotificationStack(feed(3), 0);
    expect(stack.entries[0]?.isCollapsed).toBe(false);
  });

  it("rounds the column only at its two ends", () => {
    /*
     * The pile is one block. Given a corner each, every card in the middle of
     * the run cut two notches of the page out of the seam it shares with its
     * neighbour, which is what made a column read as a handful of torn-off
     * strips instead of one thing.
     */
    const laid = planNotificationStack(feed(4), 4).entries;
    expect(
      laid.map((entry) => [entry.isColumnTop, entry.isColumnBottom]),
    ).toEqual([
      [false, true],
      [false, false],
      [false, false],
      [true, false],
    ]);
  });

  it("gives a lone card both of them", () => {
    const [only] = planNotificationStack(feed(1), 4).entries;
    expect([only.isColumnTop, only.isColumnBottom]).toEqual([true, true]);
  });

  it("never makes a card in the pile an end of the column", () => {
    // A collapsed card is a strip lying on the run, not part of it.
    const piled = planNotificationStack(feed(5), 1).entries.filter(
      (entry) => entry.isCollapsed,
    );
    expect(piled).not.toHaveLength(0);
    for (const entry of piled) {
      expect(entry.isColumnTop).toBe(false);
      expect(entry.isColumnBottom).toBe(false);
    }
  });
});
