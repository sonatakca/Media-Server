import type { MediaItem } from "./types";

/**
 * Where a title's logo sits on its media card.
 *
 * Logos are wildly inconsistent in shape, and the poster underneath varies just
 * as much: a logo that reads cleanly at the foot of one card lands on a face or
 * a bright sky on the next. So this is a per-title choice rather than one rule
 * for the whole library.
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

/**
 * Whether the logo is drawn in its own layer rather than in the block at the
 * foot of the card.
 *
 * The bottom block also holds the year and rating tags and the gradient they
 * sit on, so a logo anchored anywhere else has to leave it.
 */
export function isLogoLifted(placement: LogoPlacement): boolean {
  return placement !== "bottom";
}

/** Vertical anchor for a lifted logo layer, which spans the card. */
export function getCardLogoAnchorClass(placement: LogoPlacement): string {
  if (placement === "top") return "top-0";
  if (placement === "middle") return "top-1/2 -translate-y-1/2";
  // Bottom never uses this layer; it stays with the tags.
  return "bottom-0";
}

export function getLogoPlacementLabelKey(
  placement: LogoPlacement,
): `logoPlacement.${LogoPlacement}` {
  return `logoPlacement.${placement}`;
}
