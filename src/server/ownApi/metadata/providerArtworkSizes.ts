/**
 * The provider size every artwork type is imported at.
 *
 * TMDB's named widths are pre-scaled derivatives, so importing a backdrop at
 * `w1280` stored a 1280px file that the 1920px hero then had to stretch —
 * visibly softer than the same title's pre-migration 3840px backdrop, from the
 * same source image. The variant pipeline renders every delivered width from
 * the stored original, so the original is the only size worth keeping: a
 * narrower import caps every variant beneath it and the detail is gone for
 * good.
 *
 * `original` is the widest size TMDB publishes for all four types, and those
 * files stay well inside the storage layer's ceilings — backdrops top out at
 * 3840x2160, posters around 2000x3000, both far below MAX_IMAGE_BYTES and the
 * decoder's pixel limit.
 */
export const PROVIDER_ARTWORK_SIZES = {
  poster: "original",
  backdrop: "original",
  logo: "original",
  still: "original",
} as const;

/** The preview grid wants many images at once, so it asks for small ones. */
export const PROVIDER_PREVIEW_SIZE = "w342";
