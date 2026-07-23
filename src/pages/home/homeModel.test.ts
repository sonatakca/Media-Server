import { describe, expect, it } from "vitest";
import type { JellyfinItem } from "../../lib/types";
import {
  getHomeLoadErrorMessage,
  removeContinueWatchingItem,
  replaceContinueWatchingItems,
} from "./homeModel";

describe("homeModel", () => {
  const first = { Id: "first", Name: "First" } as JellyfinItem;
  const second = { Id: "second", Name: "Second" } as JellyfinItem;
  const data = {
    continueWatching: [first, second],
    latestMedia: [second],
    desktopOnly: "preserved",
  };

  it("preserves unrelated home data while replacing smart continue watching", () => {
    expect(replaceContinueWatchingItems(data, [second])).toEqual({
      ...data,
      continueWatching: [second],
    });
    expect(replaceContinueWatchingItems(null, [second])).toBeNull();
  });

  it("removes only the cleared continue-watching item", () => {
    expect(removeContinueWatchingItem(data, "first")).toEqual({
      ...data,
      continueWatching: [second],
    });
    expect(removeContinueWatchingItem(null, "first")).toBeNull();
  });

  it("preserves rejected-result error fallback behavior", () => {
    expect(
      getHomeLoadErrorMessage(
        { status: "rejected", reason: new Error("backend failed") },
        "fallback",
      ),
    ).toBe("backend failed");
    expect(
      getHomeLoadErrorMessage(
        { status: "rejected", reason: "backend failed" },
        "fallback",
      ),
    ).toBe("fallback");
  });
});
