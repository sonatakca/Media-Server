/**
 * The small superscript tag beside a rendition, as streaming players use it.
 *
 * It answers a different question from the number next to it. "1440p" is a
 * measurement; "HD" is a class, and the class is what most people actually
 * choose by — which is why the tag earns its place rather than repeating what
 * the label already says.
 *
 * Only the classes worth calling out get one. Everything at 720p and below is
 * unremarkable, and tagging it would make the list noisier without helping
 * anyone pick.
 */

export type QualityBadge = "4K" | "HD";

/** Anything at or above this is sold as 4K, whatever its exact width. */
const FOUR_K_HEIGHT = 2160;

/** And anything at or above this is high definition. */
const HD_HEIGHT = 1080;

/**
 * Reads the badge from a rendition height.
 *
 * Heights are the rung's class rather than the frame it emits — a 2.39:1
 * master's 2160p rung is 3840x1608 — so the class is what must be consulted,
 * not the picture's real height.
 */
export function qualityBadgeForHeight(
  height: number | undefined,
): QualityBadge | undefined {
  if (typeof height !== "number" || !Number.isFinite(height)) return undefined;
  if (height >= FOUR_K_HEIGHT) return "4K";
  if (height >= HD_HEIGHT) return "HD";
  return undefined;
}

/**
 * Falls back to the label when no height is carried.
 *
 * The complete-file path labels its renditions "1080p", "Original (2160p)" and
 * so on, and those are the only description available for a source whose
 * height was never recorded separately.
 */
export function qualityBadgeForLabel(
  label: string,
  height?: number,
): QualityBadge | undefined {
  const fromHeight = qualityBadgeForHeight(height);
  if (fromHeight) return fromHeight;
  // The last run of digits before a "p", which is how every rung is written.
  const matches = [...label.matchAll(/(\d{3,4})p/g)];
  const parsed = matches.at(-1)?.[1];
  return parsed ? qualityBadgeForHeight(Number(parsed)) : undefined;
}
