import { describe, expect, it } from "vitest";
import { OwnApiClientError } from "../../api/ownApi/client";
import { translations, type TranslationKey } from "../../i18n/translations";
import type { MediaItem } from "../../lib/types";
import {
  getHomeLoadErrorMessage,
  removeContinueWatchingItem,
  replaceContinueWatchingItems,
} from "./homeModel";

const t = (key: TranslationKey) => translations.tr[key];

describe("homeModel", () => {
  const first = { Id: "first", Name: "First" } as MediaItem;
  const second = { Id: "second", Name: "Second" } as MediaItem;
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
        t,
        "fallback",
      ),
    ).toBe("backend failed");
    expect(
      getHomeLoadErrorMessage(
        { status: "rejected", reason: "backend failed" },
        t,
        "fallback",
      ),
    ).toBe("fallback");
    expect(
      getHomeLoadErrorMessage(
        {
          status: "rejected",
          reason: new OwnApiClientError({
            status: 0,
            code: "NETWORK_ERROR",
            message: "Seyirlik could not reach the server.",
          }),
        },
        t,
        "fallback",
      ),
    ).toBe("Seyirlik sunucuya ulaşamadı.");
  });
});
