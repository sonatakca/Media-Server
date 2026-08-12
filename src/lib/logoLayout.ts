import type { MediaItem } from "./types";

/**
 * Where a title's logo sits on its media card, and how large it is.
 *
 * Fractions of the card rather than pixels, because the same card is drawn at
 * several sizes — a poster in the grid, a wide tile in Continue Watching — and
 * a layout chosen at one size has to hold at the others.
 *
 * `x` and `y` locate the centre of the logo; `width` is its width. Anchoring by
 * centre is what makes dragging feel right: the logo moves with the pointer
 * instead of pivoting around a corner.
 */
export interface LogoLayout {
  x: number;
  y: number;
  width: number;
  /**
   * Shadow strength. 0 turns it off, 1 matches the hero's treatment, and above
   * that deepens it for a logo sitting on bright artwork.
   */
  shadow: number;
}

/**
 * A logo may not be scaled below this or it stops being legible, nor above it
 * or it stops being a logo and becomes the card.
 */
export const MIN_LOGO_WIDTH = 0.15;
export const MAX_LOGO_WIDTH = 1;

export const MIN_LOGO_SHADOW = 0;
export const MAX_LOGO_SHADOW = 2;
export const DEFAULT_LOGO_SHADOW = 1;

/**
 * The layout an editor opens on when a title has never been adjusted.
 *
 * Deliberately close to where the untouched card already draws its logo, so
 * picking the title up and putting it down again changes as little as possible.
 */
export const INITIAL_LOGO_LAYOUT: LogoLayout = {
  x: 0.5,
  y: 0.8,
  width: 0.74,
  shadow: DEFAULT_LOGO_SHADOW,
};

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampLogoLayout(layout: LogoLayout): LogoLayout {
  const width = Number.isFinite(layout.width)
    ? Math.min(MAX_LOGO_WIDTH, Math.max(MIN_LOGO_WIDTH, layout.width))
    : INITIAL_LOGO_LAYOUT.width;

  const shadow = Number.isFinite(layout.shadow)
    ? Math.min(MAX_LOGO_SHADOW, Math.max(MIN_LOGO_SHADOW, layout.shadow))
    : DEFAULT_LOGO_SHADOW;

  return { x: clampUnit(layout.x), y: clampUnit(layout.y), width, shadow };
}

/**
 * Reads a stored layout, or null when the title has never been adjusted.
 *
 * Null is meaningful rather than a missing value: it means "draw the card the
 * way it has always been drawn", which is not the same as any particular set of
 * numbers and must stay pixel-identical.
 */
export function getLogoLayout(item?: MediaItem | null): LogoLayout | null {
  const layout = item?.LogoLayout;
  if (
    !layout ||
    typeof layout.x !== "number" ||
    typeof layout.y !== "number" ||
    typeof layout.width !== "number" ||
    !Number.isFinite(layout.x) ||
    !Number.isFinite(layout.y) ||
    !Number.isFinite(layout.width)
  ) {
    return null;
  }
  return clampLogoLayout(layout);
}

/** Inline style placing the logo on a card, given a stored layout. */
export function getLogoLayoutStyle(layout: LogoLayout): {
  left: string;
  top: string;
  width: string;
  transform: string;
} {
  return {
    left: `${layout.x * 100}%`,
    top: `${layout.y * 100}%`,
    width: `${layout.width * 100}%`,
    transform: "translate(-50%, -50%)",
  };
}

export interface Rect {
  width: number;
  height: number;
}

/**
 * Moves the logo by a pointer delta measured in pixels on a card of `bounds`.
 *
 * The delta is converted to fractions here rather than at the call site so the
 * editor never has to know that the stored units are not pixels.
 */
export function moveLogoLayout(
  layout: LogoLayout,
  deltaXPx: number,
  deltaYPx: number,
  bounds: Rect,
): LogoLayout {
  if (bounds.width <= 0 || bounds.height <= 0) return layout;
  return clampLogoLayout({
    ...layout,
    x: layout.x + deltaXPx / bounds.width,
    y: layout.y + deltaYPx / bounds.height,
  });
}

/** Which corner a resize is being dragged from. */
export type ResizeCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/**
 * Resizes about the centre, so the logo grows evenly in both directions and
 * does not crawl across the card while being scaled.
 *
 * Dragging a left-hand corner leftwards makes it wider, which is why the
 * horizontal delta is inverted for those corners.
 */
export function resizeLogoLayout(
  layout: LogoLayout,
  corner: ResizeCorner,
  deltaXPx: number,
  bounds: Rect,
): LogoLayout {
  if (bounds.width <= 0) return layout;

  const outward = corner === "top-left" || corner === "bottom-left" ? -1 : 1;
  // Doubled because the centre stays put: each edge moves by half the change.
  const widthDelta = (2 * outward * deltaXPx) / bounds.width;

  return clampLogoLayout({ ...layout, width: layout.width + widthDelta });
}

/** One arrow-key press, as a fraction of the card. */
export const LOGO_NUDGE_STEP = 0.01;

/**
 * The card logo's shadow, scaled.
 *
 * Two stacked drop-shadows like the hero's: a long soft one that lifts the logo
 * off the artwork, and a tight one that keeps its edges readable. Both scale
 * together, so a single control covers "barely there" to "over a white sky".
 *
 * Returns undefined at zero rather than a no-op filter, so a logo that needs no
 * shadow does not pay for one being composited.
 */
export function getLogoShadowFilter(shadow: number): string | undefined {
  const strength = Number.isFinite(shadow)
    ? Math.min(MAX_LOGO_SHADOW, Math.max(MIN_LOGO_SHADOW, shadow))
    : DEFAULT_LOGO_SHADOW;
  if (strength <= 0) return undefined;

  const spread = Math.round(34 * strength);
  const glow = Math.round(18 * strength);
  const drop = Math.round(14 * strength);
  const far = Math.min(0.9, 0.9 * strength).toFixed(2);
  const near = Math.min(0.65, 0.65 * strength).toFixed(2);

  return `drop-shadow(0 ${drop}px ${spread}px rgba(0, 0, 0, ${far})) drop-shadow(0 0 ${glow}px rgba(0, 0, 0, ${near}))`;
}

/**
 * A soft field behind the complete logo image.
 *
 * `drop-shadow()` follows transparent pixels, which is ideal for provider
 * logos but almost invisible when an uploaded logo has an opaque rectangular
 * background. This field gives those custom images the same adjustable
 * separation from the artwork without changing the image itself.
 */
export function getLogoShadowBackdropStyle(shadow: number):
  | {
      backgroundColor: string;
      filter: string;
      transform: string;
    }
  | undefined {
  const strength = Number.isFinite(shadow)
    ? Math.min(MAX_LOGO_SHADOW, Math.max(MIN_LOGO_SHADOW, shadow))
    : DEFAULT_LOGO_SHADOW;
  if (strength <= 0) return undefined;

  const opacity = Math.min(0.76, 0.38 * strength).toFixed(2);
  const blur = Math.round(18 * strength);
  const scale = (1 + 0.12 * strength).toFixed(2);

  return {
    backgroundColor: `rgba(0, 0, 0, ${opacity})`,
    filter: `blur(${blur}px)`,
    transform: `scale(${scale})`,
  };
}
