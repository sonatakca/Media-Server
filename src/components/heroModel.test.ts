import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JellyfinItem } from "../lib/types";
import {
  HERO_TRAILERS_ENABLED_STORAGE_KEY,
  getHeroImageCandidates,
  readHeroTrailersEnabledPreference,
  saveHeroTrailersEnabledPreference,
} from "./hero/heroModel";

vi.mock("../lib/jellyfinApi", () => ({
  getBackdropImageUrl: vi.fn(
    (id: string, tag: string, width: number) =>
      `backdrop:${id}:${tag}:${width}`,
  ),
  getPrimaryImageUrl: vi.fn(
    (id: string, tag: string, width: number) => `primary:${id}:${tag}:${width}`,
  ),
}));

describe("heroModel", () => {
  beforeEach(() => localStorage.clear());

  it("preserves trailer preference defaults and storage shape", () => {
    expect(HERO_TRAILERS_ENABLED_STORAGE_KEY).toBe(
      "seyirlik-hero-trailers-enabled",
    );
    expect(readHeroTrailersEnabledPreference()).toBe(true);
    saveHeroTrailersEnabledPreference(false);
    expect(localStorage.getItem(HERO_TRAILERS_ENABLED_STORAGE_KEY)).toBe(
      "false",
    );
    expect(readHeroTrailersEnabledPreference()).toBe(false);
  });

  it("preserves hero image candidate order, type, and widths", () => {
    expect(
      getHeroImageCandidates({
        Id: "episode",
        Name: "Episode",
        BackdropImageTags: ["own"],
        ParentBackdropItemId: "series",
        ParentBackdropImageTags: ["parent"],
        ImageTags: { Primary: "poster" },
      } as JellyfinItem),
    ).toEqual([
      { type: "backdrop", url: "backdrop:episode:own:2200" },
      { type: "backdrop", url: "backdrop:series:parent:2200" },
      { type: "primary", url: "primary:episode:poster:900" },
    ]);
    expect(getHeroImageCandidates()).toEqual([]);
  });
});
