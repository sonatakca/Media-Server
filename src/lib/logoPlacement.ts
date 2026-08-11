import type { MediaItem } from "./types";

/**
 * Where a title's logo is anchored over its artwork.
 *
 * Logos are wildly inconsistent in shape — a wide wordmark and a tall stacked
 * crest want different vertical anchors over the same backdrop — so this is a
 * per-title choice rather than one rule for the whole library.
 */
export type LogoPlacement = "top" | "middle" | "bottom";

/**
 * Bottom is the default because it is where every logo sat before this was
 * settable, so a title nobody has configured looks exactly as it always did.
 */
export const DEFAULT_LOGO_PLACEMENT: LogoPlacement = "bottom";

export const LOGO_PLACEMENTS: LogoPlacement[] = ["top", "middle", "bottom"];

export function isLogoPlacement(value: unknown): value is LogoPlacement {
  return (
    value === "top" || value === "middle" || value === "bottom"
  );
}

export function getLogoPlacement(item?: MediaItem | null): LogoPlacement {
  return isLogoPlacement(item?.LogoPlacement)
    ? item.LogoPlacement
    : DEFAULT_LOGO_PLACEMENT;
}

/** Flex alignment for the box the logo is laid out in. */
export function getLogoAlignmentClass(placement: LogoPlacement): string {
  if (placement === "top") return "items-start";
  if (placement === "middle") return "items-center";
  return "items-end";
}

/**
 * The hero scales the logo down as its intro settles. The origin has to follow
 * the anchor, otherwise a top-placed logo would shrink away from the edge it
 * was just pinned to.
 */
export function getLogoTransformOrigin(placement: LogoPlacement): string {
  if (placement === "top") return "left top";
  if (placement === "middle") return "left center";
  return "left bottom";
}

export function getLogoPlacementLabelKey(
  placement: LogoPlacement,
): `logoPlacement.${LogoPlacement}` {
  return `logoPlacement.${placement}`;
}
