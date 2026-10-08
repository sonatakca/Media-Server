import { describe, expect, it } from "vitest";
import {
  WORDMARK_FRAME_HEIGHT,
  WORDMARK_FRAME_WIDTH,
  getWordmarkShadowFrameStyle,
  getWordmarkShadowPad,
} from "./navbarWordmarkShadow";

const percent = (value: string) => Number.parseFloat(value) / 100;

describe("navbar wordmark shadow frames", () => {
  it("pads furthest below, where both shadows fall", () => {
    const pad = getWordmarkShadowPad();

    expect(pad.left).toBe(pad.right);
    expect(pad.bottom).toBeGreaterThan(pad.left);
    expect(pad.top).toBeLessThan(pad.left);
    expect(pad.top).toBeGreaterThan(0);
  });

  it("lands the letters exactly on the wordmark's box", () => {
    const pad = getWordmarkShadowPad();
    const style = getWordmarkShadowFrameStyle();
    const left = percent(style.left);
    const top = percent(style.top);
    const width = percent(style.width);
    const height = percent(style.height);
    const bakedWidth = WORDMARK_FRAME_WIDTH + pad.left + pad.right;
    const bakedHeight = WORDMARK_FRAME_HEIGHT + pad.top + pad.bottom;

    // Where the plain frame's corners fall, as fractions of the box.
    expect(left + (width * pad.left) / bakedWidth).toBeCloseTo(0, 5);
    expect(top + (height * pad.top) / bakedHeight).toBeCloseTo(0, 5);
    expect(
      left + (width * (pad.left + WORDMARK_FRAME_WIDTH)) / bakedWidth,
    ).toBeCloseTo(1, 5);
    expect(
      top + (height * (pad.top + WORDMARK_FRAME_HEIGHT)) / bakedHeight,
    ).toBeCloseTo(1, 5);
  });
});
