import { useEffect, useState, type CSSProperties } from "react";

export interface BakedShadow {
  url: string;
  style: CSSProperties;
}
interface LogoShadows {
  aspect: number | null;
  base: BakedShadow | null;
  halo: BakedShadow | null;
  queue: BakedShadow | null;
}
const EMPTY: LogoShadows = {
  aspect: null,
  base: null,
  halo: null,
  queue: null,
};

/** WebKit can corrupt live filters during scaled, clipped carousel travel.
 * Rasterise only the black alpha shadows once; travel animates plain images.
 * Canvas shadowBlur is supported on Safari too (unlike Canvas filter).
 */
export function useBakedLogoShadows(
  source: string,
  boxWidth: number,
  maxHeight: number,
  queueScale = 1,
): LogoShadows {
  const [result, setResult] = useState<{
    key: string;
    shadows: LogoShadows;
  } | null>(null);
  const key = `${source}|${boxWidth}|${maxHeight}|${queueScale}`;
  useEffect(() => {
    if (!source || boxWidth <= 0) return;
    let cancelled = false;
    let owned: LogoShadows | null = null;
    void bakeLogoShadows(source, boxWidth, maxHeight, queueScale)
      .then((shadows) => {
        if (cancelled) release(shadows);
        else {
          owned = shadows;
          setResult({ key, shadows });
        }
      })
      .catch(() => {
        // Keep the unfiltered logo if its image cannot be decoded or drawn.
        if (!cancelled) setResult({ key, shadows: EMPTY });
      });
    return () => {
      cancelled = true;
      if (owned) release(owned);
    };
  }, [source, boxWidth, maxHeight, queueScale, key]);
  return result?.key === key ? result.shadows : EMPTY;
}

function release(shadows: LogoShadows) {
  for (const image of [shadows.base, shadows.halo, shadows.queue]) {
    if (image) URL.revokeObjectURL(image.url);
  }
}

export async function bakeLogoShadows(
  source: string,
  boxWidth: number,
  maxHeight: number,
  queueScale: number,
): Promise<LogoShadows> {
  const response = await fetch(source, { credentials: "include" });
  if (!response.ok)
    throw new Error(`Logo shadow request failed: ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const made: BakedShadow[] = [];
  try {
    const width = Math.min(bitmap.width, 1100);
    const height = Math.max(
      1,
      Math.round((bitmap.height * width) / bitmap.width),
    );
    // Shadow sizes are in the title box's px; the logo is drawn across the
    // box's width unless its height cap makes it narrower.
    const aspect = bitmap.width / bitmap.height;
    const px = width / Math.min(boxWidth, maxHeight * aspect);
    const draw = async (
      layers: { blur: number; dy: number; alpha: number }[],
    ) => {
      const pad =
        Math.ceil(
          Math.max(...layers.map((s) => (3 * s.blur + Math.abs(s.dy)) * px)),
        ) + 2;
      const canvas = document.createElement("canvas");
      canvas.width = width + pad * 2;
      canvas.height = height + pad * 2;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("No logo shadow canvas context");
      // The source paints outside the canvas; only its shadow lands inside it.
      const offset = canvas.width + width + pad;
      for (const layer of layers) {
        context.shadowColor = `rgba(0,0,0,${layer.alpha})`;
        context.shadowBlur = layer.blur * px * 2;
        context.shadowOffsetX = offset;
        context.shadowOffsetY = layer.dy * px;
        context.drawImage(bitmap, pad - offset, pad, width, height);
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("No logo shadow blob"))),
          "image/png",
        ),
      );
      const image = {
        url: URL.createObjectURL(blob),
        style: {
          left: `${(-100 * pad) / width}%`,
          top: `${(-100 * pad) / height}%`,
          width: `${(100 * canvas.width) / width}%`,
          height: `${(100 * canvas.height) / height}%`,
          maxWidth: "none",
        },
      };
      made.push(image);
      return image;
    };
    const base = await draw([{ blur: 30, dy: 6, alpha: 0.55 }]);
    const halo = await draw([
      { blur: 3, dy: 0, alpha: 0.55 },
      { blur: 22, dy: 0, alpha: 0.6 },
    ]);
    const queue = await draw([
      {
        blur: 5 / Math.max(queueScale, 0.01),
        dy: 2 / Math.max(queueScale, 0.01),
        alpha: 1,
      },
    ]);
    return { aspect, base, halo, queue };
  } catch (error) {
    made.forEach((image) => URL.revokeObjectURL(image.url));
    throw error;
  } finally {
    bitmap.close();
  }
}
