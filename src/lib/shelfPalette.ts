/**
 * The colours a picture is made of, the way a film's palette is read off its
 * frames: median cut for the colours, Oklab for telling them apart.
 */

export type Rgb = [number, number, number];

export interface Swatch {
  rgb: Rgb;
  share: number;
}

/** A colour covering less of the cover than this is a detail, not a colour. */
const MIN_COLOUR_SHARE = 0.04;
/** Colours closer than this (Oklab distance) read as one. */
const MERGE_DISTANCE = 0.06;

/** sRGB 0–255 to Oklab, where distance tracks how different colours look. */
export function toOklab([r, g, b]: Rgb): Rgb {
  const linear = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lr = linear(r);
  const lg = linear(g);
  const lb = linear(b);
  const l = Math.cbrt(
    0.4122214708 * lr + 0.5363288628 * lg + 0.0514459929 * lb,
  );
  const m = Math.cbrt(
    0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
  );
  const s = Math.cbrt(
    0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
  );
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Median cut: split the colour box with the most spread, along its widest
 * channel, at its median, until there are `count` boxes, then refine.
 * Deterministic, so a shelf paints the same picture every visit.
 */
export function medianCut(pixels: Rgb[], count: number): Swatch[] {
  if (pixels.length === 0) return [];
  let boxes: Rgb[][] = [pixels];
  while (boxes.length < count) {
    let widest = -1;
    let widestChannel = 0;
    let widestScore = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let channel = 0; channel < 3; channel += 1) {
        let low = 255;
        let high = 0;
        for (const pixel of box) {
          low = Math.min(low, pixel[channel]!);
          high = Math.max(high, pixel[channel]!);
        }
        const score = (high - low) * Math.sqrt(box.length);
        if (score > widestScore) {
          widestScore = score;
          widest = index;
          widestChannel = channel;
        }
      }
    });
    if (widest < 0 || widestScore === 0) break;
    const box = [...boxes[widest]!].sort(
      (a, b) => a[widestChannel]! - b[widestChannel]!,
    );
    const middle = Math.floor(box.length / 2);
    boxes = [
      ...boxes.slice(0, widest),
      box.slice(0, middle),
      box.slice(middle),
      ...boxes.slice(widest + 1),
    ];
  }
  return refine(pixels, boxes.map(mean));
}

/** Passes of nearest-colour reassignment after the cut. */
const REFINE_PASSES = 6;

function mean(pixels: Rgb[]): Rgb {
  const sum: Rgb = [0, 0, 0];
  for (const pixel of pixels) {
    sum[0] += pixel[0];
    sum[1] += pixel[1];
    sum[2] += pixel[2];
  }
  return [
    sum[0] / pixels.length,
    sum[1] / pixels.length,
    sum[2] / pixels.length,
  ];
}

/**
 * A cut at the median can halve one colour and box a half with another,
 * whose mean is then a colour the picture never had: half a red and a blue
 * make a purple. Moving each pixel to its nearest colour and re-taking the
 * means (k-means, seeded by the cut) puts every colour back together.
 */
function refine(pixels: Rgb[], seeds: Rgb[]): Swatch[] {
  let centres = seeds;
  let groups: Rgb[][] = [];
  for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
    groups = centres.map(() => []);
    for (const pixel of pixels) {
      let nearest = 0;
      let nearestDistance = Infinity;
      centres.forEach((centre, index) => {
        const d =
          (pixel[0] - centre[0]) ** 2 +
          (pixel[1] - centre[1]) ** 2 +
          (pixel[2] - centre[2]) ** 2;
        if (d < nearestDistance) {
          nearestDistance = d;
          nearest = index;
        }
      });
      groups[nearest]!.push(pixel);
    }
    groups = groups.filter((group) => group.length > 0);
    centres = groups.map(mean);
  }
  return groups.map((group, index) => ({
    rgb: centres[index]!,
    share: group.length / pixels.length,
  }));
}

/** Folds colours that read as one, then drops the specks. Darkest first. */
export function settlePalette(swatches: Swatch[]): Swatch[] {
  const merged: Swatch[] = [];
  for (const swatch of [...swatches].sort((a, b) => b.share - a.share)) {
    const near = merged.find(
      (kept) =>
        distance(toOklab(kept.rgb), toOklab(swatch.rgb)) < MERGE_DISTANCE,
    );
    if (!near) {
      merged.push({ ...swatch });
      continue;
    }
    const total = near.share + swatch.share;
    near.rgb = near.rgb.map(
      (channel, index) =>
        (channel * near.share + swatch.rgb[index]! * swatch.share) / total,
    ) as Rgb;
    near.share = total;
  }
  const kept = merged.filter((swatch) => swatch.share >= MIN_COLOUR_SHARE);
  const total = kept.reduce((sum, swatch) => sum + swatch.share, 0);
  return kept
    .map((swatch) => ({ ...swatch, share: swatch.share / total }))
    .sort((a, b) => toOklab(a.rgb)[0] - toOklab(b.rgb)[0]);
}
