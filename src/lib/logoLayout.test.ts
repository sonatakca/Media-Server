import { describe, expect, it } from "vitest";
import type { MediaItem } from "./types";
import {
  INITIAL_LOGO_LAYOUT,
  MAX_LOGO_WIDTH,
  MIN_LOGO_WIDTH,
  MAX_LOGO_SHADOW,
  clampLogoLayout,
  getLogoLayout,
  getLogoShadowFilter,
  getLogoLayoutStyle,
  moveLogoLayout,
  resizeLogoLayout,
} from "./logoLayout";

const CARD = { width: 200, height: 300 };

function item(layout?: unknown): MediaItem {
  return { Id: "a", Name: "Dune", LogoLayout: layout } as MediaItem;
}

describe("reading a stored layout", () => {
  it("treats an absent layout as never adjusted", () => {
    // Null is not a position. It means "draw the card the way it has always
    // been drawn", which no set of numbers can express.
    expect(getLogoLayout(item())).toBeNull();
    expect(getLogoLayout(undefined)).toBeNull();
    expect(getLogoLayout(null)).toBeNull();
  });

  it("rejects a partial or non-numeric layout rather than half-applying it", () => {
    expect(getLogoLayout(item({ x: 0.5, y: 0.5 }))).toBeNull();
    expect(getLogoLayout(item({ x: "0.5", y: 0.5, width: 0.5, shadow: 1 }))).toBeNull();
    expect(getLogoLayout(item({ x: Number.NaN, y: 0.5, width: 0.5, shadow: 1 }))).toBeNull();
  });

  it("clamps a stored layout that is out of range", () => {
    expect(getLogoLayout(item({ x: 2, y: -1, width: 5, shadow: 9 }))).toEqual({
      x: 1,
      y: 0,
      width: MAX_LOGO_WIDTH,
      shadow: MAX_LOGO_SHADOW,
    });
  });
});

describe("layout geometry", () => {
  it("anchors by centre so a drag tracks the pointer", () => {
    expect(getLogoLayoutStyle({ x: 0.25, y: 0.4, width: 0.6, shadow: 1 })).toEqual({
      left: "25%",
      top: "40%",
      width: "60%",
      transform: "translate(-50%, -50%)",
    });
  });

  it("keeps a logo legible and smaller than the card", () => {
    expect(clampLogoLayout({ x: 0.5, y: 0.5, width: 0.01, shadow: 1 }).width).toBe(
      MIN_LOGO_WIDTH,
    );
    expect(clampLogoLayout({ x: 0.5, y: 0.5, width: 9, shadow: 1 }).width).toBe(
      MAX_LOGO_WIDTH,
    );
  });

  it("falls back to the opening size when the width is not a number", () => {
    expect(
      clampLogoLayout({ x: 0.5, y: 0.5, width: Number.NaN, shadow: 1 }).width,
    ).toBe(INITIAL_LOGO_LAYOUT.width);
  });
});

describe("shadow", () => {
  it("turns off completely at zero rather than compositing a no-op filter", () => {
    // A logo that carries its own outline needs no shadow, and should not pay
    // for one being drawn.
    expect(getLogoShadowFilter(0)).toBeUndefined();
    expect(getLogoShadowFilter(-1)).toBeUndefined();
  });

  it("scales both shadows together", () => {
    const normal = getLogoShadowFilter(1) ?? "";
    const strong = getLogoShadowFilter(2) ?? "";

    expect(normal).toContain("drop-shadow");
    // The long lift and the tight edge both grow, so a logo on bright artwork
    // gains separation without the edges going soft.
    expect(strong).toContain("68px");
    expect(strong).toContain("36px");
  });

  it("falls back to the default when the strength is not a number", () => {
    expect(getLogoShadowFilter(Number.NaN)).toBe(getLogoShadowFilter(1));
  });

  it("does not deepen past full opacity however high it is pushed", () => {
    expect(getLogoShadowFilter(2)).toContain("0.90");
  });
});

describe("dragging", () => {
  it("converts a pixel delta into a fraction of the card", () => {
    const moved = moveLogoLayout(
      { x: 0.5, y: 0.5, width: 0.5, shadow: 1 },
      20,
      -30,
      CARD,
    );

    expect(moved.x).toBeCloseTo(0.6);
    expect(moved.y).toBeCloseTo(0.4);
  });

  it("stops at the edges of the card", () => {
    const moved = moveLogoLayout({ x: 0.9, y: 0.1, width: 0.5, shadow: 1 }, 400, -400, CARD);
    expect(moved).toMatchObject({ x: 1, y: 0 });
  });

  it("does nothing before the card has been measured", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };
    expect(moveLogoLayout(layout, 20, 20, { width: 0, height: 0 })).toBe(layout);
  });
});

describe("resizing", () => {
  it("grows about the centre, so the logo does not crawl while scaling", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };
    const resized = resizeLogoLayout(layout, "bottom-right", 20, CARD);

    // Each edge moves by the drag, so the width changes by twice it.
    expect(resized.width).toBeCloseTo(0.7);
    expect(resized.x).toBe(layout.x);
    expect(resized.y).toBe(layout.y);
  });

  it("treats a leftward drag on a left-hand corner as growing", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };

    expect(resizeLogoLayout(layout, "top-left", -20, CARD).width).toBeCloseTo(
      0.7,
    );
    expect(resizeLogoLayout(layout, "bottom-left", 20, CARD).width).toBeCloseTo(
      0.3,
    );
  });

  it("will not shrink below legible or grow past the card", () => {
    const layout = { x: 0.5, y: 0.5, width: 0.5, shadow: 1 };
    expect(resizeLogoLayout(layout, "bottom-right", -500, CARD).width).toBe(
      MIN_LOGO_WIDTH,
    );
    expect(resizeLogoLayout(layout, "bottom-right", 500, CARD).width).toBe(
      MAX_LOGO_WIDTH,
    );
  });
});
