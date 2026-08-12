import { MAX_ARTWORK_WIDTH } from "../../lib/artworkSizes";
import { getBackdropImageUrl, getPrimaryImageUrl } from "../../lib/mediaApi";
import type { MediaItem } from "../../lib/types";

export const HERO_TRAILERS_ENABLED_STORAGE_KEY =
  "seyirlik-hero-trailers-enabled";

export type HeroImageType = "backdrop" | "primary";

export interface HeroImageCandidate {
  type: HeroImageType;
  url: string;
}

export function readHeroTrailersEnabledPreference(): boolean {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    return (
      window.localStorage.getItem(HERO_TRAILERS_ENABLED_STORAGE_KEY) !== "false"
    );
  } catch {
    return true;
  }
}

export function saveHeroTrailersEnabledPreference(enabled: boolean) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      HERO_TRAILERS_ENABLED_STORAGE_KEY,
      enabled ? "true" : "false",
    );
  } catch {
    // Ignore storage failures so private browsing never blocks the hero UI.
  }
}

export function getHeroImageCandidates(item?: MediaItem): HeroImageCandidate[] {
  if (!item) {
    return [];
  }

  const candidates: HeroImageCandidate[] = [];

  // The hero is full-bleed, so it asks for the largest artwork the pipeline
  // renders. Asking for more than that used to fail the request outright and
  // drop the hero back to the poster.
  if (item.BackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(
        item.Id,
        item.BackdropImageTags[0],
        MAX_ARTWORK_WIDTH,
      ),
    });
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(
        item.ParentBackdropItemId,
        item.ParentBackdropImageTags[0],
        MAX_ARTWORK_WIDTH,
      ),
    });
  }

  if (item.ImageTags?.Primary) {
    candidates.push({
      type: "primary",
      url: getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 900),
    });
  }

  return candidates;
}
