import { describe, expect, it } from "vitest";
import {
  ARTWORK_VARIANT_WIDTHS,
  MAX_ARTWORK_WIDTH,
  clampArtworkWidth,
} from "./artworkSizes";

describe("artworkSizes", () => {
  it("clamps a request wider than the pipeline renders", () => {
    // The hero used to ask for 2200, which the image endpoint rejected.
    expect(clampArtworkWidth(2200)).toBe(MAX_ARTWORK_WIDTH);
    expect(clampArtworkWidth(Number.MAX_SAFE_INTEGER)).toBe(MAX_ARTWORK_WIDTH);
  });

  it("leaves supported widths alone", () => {
    expect(clampArtworkWidth(900)).toBe(900);
    expect(clampArtworkWidth(MAX_ARTWORK_WIDTH)).toBe(MAX_ARTWORK_WIDTH);
  });

  it("never returns a width below one pixel", () => {
    expect(clampArtworkWidth(0)).toBe(1);
    expect(clampArtworkWidth(-500)).toBe(1);
  });

  it("rounds fractional widths", () => {
    expect(clampArtworkWidth(519.4)).toBe(519);
  });

  it("tops the rendered variant ladder out at the shared ceiling", () => {
    expect(ARTWORK_VARIANT_WIDTHS.at(-1)).toBe(MAX_ARTWORK_WIDTH);
    expect([...ARTWORK_VARIANT_WIDTHS]).toEqual(
      [...ARTWORK_VARIANT_WIDTHS].sort((left, right) => left - right),
    );
  });
});
