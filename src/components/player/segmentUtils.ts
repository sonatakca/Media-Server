import type { TranslationKey } from "../../i18n/translations";
import { SKIPPABLE_SEGMENT_TYPES } from "./constants";

export function isSkippableSegmentType(type: string): boolean {
  return SKIPPABLE_SEGMENT_TYPES.has(type.toLowerCase());
}

export function isNextEpisodeSegmentType(type: string): boolean {
  const normalizedType = type.toLowerCase().replace(/[^a-z0-9]+/g, "");

  return (
    normalizedType.includes("nextup") ||
    normalizedType.includes("upnext") ||
    normalizedType.includes("nextepisode")
  );
}

export function getSkipSegmentLabelKey(type: string): TranslationKey {
  switch (type.toLowerCase()) {
    case "intro":
      return "player.skipIntro";
    case "recap":
      return "player.skipRecap";
    case "outro":
      return "player.skipOutro";
    default:
      return "player.skipSegment";
  }
}
