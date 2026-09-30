import { describe, expect, it } from "vitest";
import { TOUCH_DOUBLE_TAP_THRESHOLD_MS } from "./constants";
import { classifyTouchTap } from "./useTouchSeek";

const idle = { isActive: false, lastTapSide: null, lastTapTime: 0 } as const;

describe("classifyTouchTap", () => {
  it("treats a first tap as an ordinary tap", () => {
    expect(classifyTouchTap(idle, "left", 1_000)).toBe("single");
  });

  it("seeks on a second tap on the same side inside the threshold", () => {
    const after = {
      isActive: false,
      lastTapSide: "right",
      lastTapTime: 1_000,
    } as const;
    expect(classifyTouchTap(after, "right", 1_100)).toBe("double-tap");
    expect(
      classifyTouchTap(after, "right", 1_000 + TOUCH_DOUBLE_TAP_THRESHOLD_MS),
    ).toBe("single");
    expect(classifyTouchTap(after, "left", 1_100)).toBe("single");
  });

  it("keeps seeking on every further tap once a run has started", () => {
    const seeking = {
      isActive: true,
      lastTapSide: "left",
      lastTapTime: 0,
    } as const;
    expect(classifyTouchTap(seeking, "left", 50_000)).toBe("continue-seek");
  });
});
