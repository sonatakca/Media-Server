import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ARTWORK_WIDTH } from "../lib/artworkSizes";
import type { MediaItem } from "../lib/types";
import {
  HERO_TRAILERS_ENABLED_STORAGE_KEY,
  getHeroImageCandidates,
  readHeroTrailersEnabledPreference,
  saveHeroTrailersEnabledPreference,
} from "./hero/heroModel";

vi.mock("../lib/mediaApi", () => ({
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
      } as MediaItem),
    ).toEqual([
      { type: "backdrop", url: "backdrop:episode:own:1920" },
      { type: "backdrop", url: "backdrop:series:parent:1920" },
      { type: "primary", url: "primary:episode:poster:900" },
    ]);
    expect(getHeroImageCandidates()).toEqual([]);
  });

  it("never asks the image endpoint for more than it will render", () => {
    // Asking for a wider backdrop than the variant pipeline supports used to
    // fail the request with a 422, which dropped the hero back to the poster.
    const candidates = getHeroImageCandidates({
      Id: "movie",
      Name: "Movie",
      BackdropImageTags: ["own"],
      ParentBackdropItemId: "series",
      ParentBackdropImageTags: ["parent"],
      ImageTags: { Primary: "poster" },
    } as MediaItem);

    for (const candidate of candidates) {
      const requestedWidth = Number(candidate.url.split(":").pop());

      expect(requestedWidth).toBeLessThanOrEqual(MAX_ARTWORK_WIDTH);
    }
  });
});
