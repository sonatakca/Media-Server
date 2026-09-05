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

  it("keeps the newest first for bottom anchoring so its position never moves", () => {
    // Anchoring the newest means the card just raised is always in the same
    // place, however many were already there.
    const stack = planNotificationStack(feed(3), 3);
    expect(stack.entries[0]?.notification.title).toBe("Entry 0");
    expect(stack.entries[2]?.notification.title).toBe("Entry 2");
  });

  it("paints newer cards in front of older ones", () => {
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
});
