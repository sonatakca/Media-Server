import { getBackdropImageUrl, getPrimaryImageUrl } from "../../lib/jellyfinApi";
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

export function getHeroImageCandidates(
  item?: MediaItem,
): HeroImageCandidate[] {
  if (!item) {
    return [];
  }

  const candidates: HeroImageCandidate[] = [];

  if (item.BackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 2200),
    });
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    candidates.push({
      type: "backdrop",
      url: getBackdropImageUrl(
        item.ParentBackdropItemId,
        item.ParentBackdropImageTags[0],
        2200,
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
