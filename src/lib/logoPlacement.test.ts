import { describe, expect, it } from "vitest";
import type { MediaItem } from "./types";
import {
  DEFAULT_LOGO_PLACEMENT,
  getLogoAlignmentClass,
  getLogoPlacement,
  getLogoTransformOrigin,
  isLogoPlacement,
} from "./logoPlacement";

function item(placement?: unknown): MediaItem {
  return { Id: "a", Name: "Dune", LogoPlacement: placement } as MediaItem;
}

describe("logo placement", () => {
  it("falls back to the bottom edge every logo already sat on", () => {
    // A title nobody has configured must look exactly as it did before this was
    // settable, so the absent case and the invalid case both mean bottom.
    expect(DEFAULT_LOGO_PLACEMENT).toBe("bottom");
    expect(getLogoPlacement(item())).toBe("bottom");
    expect(getLogoPlacement(undefined)).toBe("bottom");
    expect(getLogoPlacement(null)).toBe("bottom");
    expect(getLogoPlacement(item("centre"))).toBe("bottom");
    expect(getLogoPlacement(item(3))).toBe("bottom");
  });

  it("honours a configured placement", () => {
    expect(getLogoPlacement(item("top"))).toBe("top");
    expect(getLogoPlacement(item("middle"))).toBe("middle");
    expect(getLogoPlacement(item("bottom"))).toBe("bottom");
  });

  it("recognizes only the three anchors the server accepts", () => {
    expect(isLogoPlacement("top")).toBe(true);
    expect(isLogoPlacement("center")).toBe(false);
    expect(isLogoPlacement(null)).toBe(false);
  });

  it("moves the scale origin with the anchor", () => {
    // The hero shrinks the logo as its intro settles. If the origin stayed at
    // the bottom, a top-placed logo would shrink away from the edge it was
    // just pinned to.
    expect(getLogoAlignmentClass("top")).toBe("items-start");
    expect(getLogoTransformOrigin("top")).toBe("left top");

    expect(getLogoAlignmentClass("middle")).toBe("items-center");
    expect(getLogoTransformOrigin("middle")).toBe("left center");

    expect(getLogoAlignmentClass("bottom")).toBe("items-end");
    expect(getLogoTransformOrigin("bottom")).toBe("left bottom");
  });
});
