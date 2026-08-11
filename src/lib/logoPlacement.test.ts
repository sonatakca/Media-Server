import { describe, expect, it } from "vitest";
import type { MediaItem } from "./types";
import {
  DEFAULT_LOGO_PLACEMENT,
  getCardLogoAnchorClass,
  getLogoPlacement,
  isLogoLifted,
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

  it("lifts the logo out of the tag block for anything but the bottom", () => {
    // The block at the foot of the card also holds the year and rating tags and
    // the gradient they sit on, so a logo anchored elsewhere has to leave it —
    // and the default must stay exactly where it already was.
    expect(isLogoLifted("top")).toBe(true);
    expect(isLogoLifted("middle")).toBe(true);
    expect(isLogoLifted("bottom")).toBe(false);
  });

  it("anchors a lifted layer to the top or the centre of the card", () => {
    expect(getCardLogoAnchorClass("top")).toBe("top-0");
    expect(getCardLogoAnchorClass("middle")).toBe("top-1/2 -translate-y-1/2");
  });
});
