import { describe, expect, it } from "vitest";
import { medianCut, settlePalette, toOklab, type Rgb } from "./shelfPalette";

function repeat(colour: Rgb, count: number): Rgb[] {
  return Array.from({ length: count }, () => [...colour] as Rgb);
}

describe("medianCut", () => {
  it("finds the colours a picture is made of, with their shares", () => {
    const pixels = [
      ...repeat([200, 30, 30], 60),
      ...repeat([20, 40, 200], 30),
      ...repeat([240, 220, 40], 10),
    ];
    const swatches = medianCut(pixels, 3).sort((a, b) => b.share - a.share);

    expect(swatches.map((swatch) => swatch.rgb)).toEqual([
      [200, 30, 30],
      [20, 40, 200],
      [240, 220, 40],
    ]);
    expect(swatches.map((swatch) => swatch.share)).toEqual([0.6, 0.3, 0.1]);
  });

  it("stops early when a picture has fewer colours than asked for", () => {
    expect(medianCut(repeat([10, 10, 10], 50), 6)).toEqual([
      { rgb: [10, 10, 10], share: 1 },
    ]);
  });

  it("gives nothing for no pixels", () => {
    expect(medianCut([], 6)).toEqual([]);
  });
});

describe("settlePalette", () => {
  it("folds colours that read as one, weighted by their shares", () => {
    const [only] = settlePalette([
      { rgb: [100, 100, 100], share: 0.75 },
      { rgb: [104, 100, 100], share: 0.25 },
    ]);
    expect(only!.share).toBe(1);
    expect(only!.rgb[0]).toBeCloseTo(101);
  });

  it("drops specks and shares what is left, darkest first", () => {
    const palette = settlePalette([
      { rgb: [250, 250, 250], share: 0.5 },
      { rgb: [10, 10, 60], share: 0.48 },
      { rgb: [255, 0, 0], share: 0.02 },
    ]);
    expect(palette.map((swatch) => swatch.rgb)).toEqual([
      [10, 10, 60],
      [250, 250, 250],
    ]);
    expect(palette[0]!.share + palette[1]!.share).toBeCloseTo(1);
    expect(palette[0]!.share).toBeCloseTo(0.48 / 0.98);
  });
});

describe("toOklab", () => {
  it("puts black at 0 and white at 1 lightness", () => {
    expect(toOklab([0, 0, 0])[0]).toBeCloseTo(0);
    expect(toOklab([255, 255, 255])[0]).toBeCloseTo(1, 3);
  });
});
