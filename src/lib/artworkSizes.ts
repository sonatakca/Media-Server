/**
 * Artwork sizing shared by the image endpoint, the variant pipeline, and every
 * client that builds an image URL.
 *
 * These lived in three places once, and the copies drifted: the hero asked for
 * a 2200px backdrop, the endpoint rejected anything over 1920 with a 422, and
 * the hero silently fell back to the poster. Keeping the ceiling in one module
 * is what stops that happening again.
 */

/**
 * The widest variant the pipeline will ever produce. Requests above this are
 * clamped, never rejected — a client asking for more than we can render should
 * get the largest image available, not no image at all.
 */
export const MAX_ARTWORK_WIDTH = 1920;

/** Widths the variant pipeline renders; a request rounds up to the next one. */
export const ARTWORK_VARIANT_WIDTHS = [
  80,
  160,
  240,
  320,
  440,
  520,
  680,
  900,
  1280,
  1600,
  MAX_ARTWORK_WIDTH,
] as const;

export function clampArtworkWidth(maxWidth: number): number {
  return Math.max(1, Math.min(MAX_ARTWORK_WIDTH, Math.round(maxWidth)));
}
