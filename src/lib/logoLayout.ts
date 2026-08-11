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
}

/**
 * A logo may not be scaled below this or it stops being legible, nor above it
 * or it stops being a logo and becomes the card.
 */
export const MIN_LOGO_WIDTH = 0.15;
export const MAX_LOGO_WIDTH = 1;

/**
 * The layout an editor opens on when a title has never been adjusted.
 *
 * Deliberately close to where the untouched card already draws its logo, so
 * picking the title up and putting it down again changes as little as possible.
 */
export const INITIAL_LOGO_LAYOUT: LogoLayout = { x: 0.5, y: 0.8, width: 0.74 };

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function clampLogoLayout(layout: LogoLayout): LogoLayout {
  const width = Number.isFinite(layout.width)
    ? Math.min(MAX_LOGO_WIDTH, Math.max(MIN_LOGO_WIDTH, layout.width))
    : INITIAL_LOGO_LAYOUT.width;

  return { x: clampUnit(layout.x), y: clampUnit(layout.y), width };
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
