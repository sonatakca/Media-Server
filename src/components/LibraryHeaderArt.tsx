import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { getLogoImageUrl, getPrimaryImageUrl } from "../lib/mediaApi";
import {
  medianCut,
  settlePalette,
  type Rgb,
  type Swatch,
} from "../lib/shelfPalette";
import type { MediaItem } from "../lib/types";
import "./LibraryHeaderArt.css";

/**
 * The picture on the wall above a library's grid: a barcode of the shelf's
 * colours. It does nothing; it is there so the space between the navigation
 * and the search bar is not bare. It never moves once it has arrived, so it
 * cannot pull the eye from the grid the way the rotating logo it replaced did.
 */

/*
 * Each title gives its palette, the way a film's colour script is read off its
 * frames: the few colours its cover is made of, each as wide as the share of
 * the cover it covers, closed by the colour of its logo. Side by side they make
 * a barcode of the whole shelf. Covers and logos are what the page already
 * downloads, so the picture costs no work anywhere else.
 */

/** Palettes past this thin to hairlines; sample the shelf evenly instead. */
const MAX_TITLES = 60;
const SAMPLE_CONCURRENCY = 6;
/** Colours read off each cover, before near-duplicates merge. */
const COVER_COLOURS = 6;
/** The logo's stripe, as a share of its title's width. */
const LOGO_SHARE = 0.12;
/** Wider than this and a title's lines turn into paint chips; a small shelf
    makes a short barcode, centred, instead. */
const MAX_TITLE_WIDTH = 72;
/** The page is black; a colour darker than this would read as a hole. */
const DARKEST_CHANNEL = 34;
/** CSS pixels of wall between two colours of one title, and between titles. */
const SWATCH_GAP = 1;
const TITLE_GAP = 5;

interface TitlePalette {
  cover: Swatch[];
  logo: Rgb | null;
}

interface PaletteSource {
  coverUrl: string;
  logoUrl: string | null;
}

/** Pixels of an image, reduced to at most `maxSide` on its longer side. */
async function readPixels(
  url: string,
  maxSide: number,
): Promise<Uint8ClampedArray | null> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) return null;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    // Halve in steps so each pixel averages its area instead of picking one.
    let source: CanvasImageSource = bitmap;
    let sourceWidth = bitmap.width;
    let sourceHeight = bitmap.height;
    while (sourceWidth / 2 >= width && sourceHeight / 2 >= height) {
      sourceWidth = Math.round(sourceWidth / 2);
      sourceHeight = Math.round(sourceHeight / 2);
      const step = document.createElement("canvas");
      step.width = sourceWidth;
      step.height = sourceHeight;
      step.getContext("2d")?.drawImage(source, 0, 0, sourceWidth, sourceHeight);
      source = step;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close();
  }
}

async function coverPalette(url: string): Promise<Swatch[]> {
  const data = await readPixels(url, 72);
  if (!data) return [];
  const pixels: Rgb[] = [];
  for (let index = 0; index < data.length; index += 4) {
    pixels.push([data[index]!, data[index + 1]!, data[index + 2]!]);
  }
  return settlePalette(medianCut(pixels, COVER_COLOURS));
}

/** The colour a logo is drawn in: its largest opaque colour. */
async function logoColour(url: string): Promise<Rgb | null> {
  const data = await readPixels(url, 160);
  if (!data) return null;
  const pixels: Rgb[] = [];
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3]! < 200) continue;
    pixels.push([data[index]!, data[index + 1]!, data[index + 2]!]);
  }
  if (pixels.length < 20) return null;
  const [main] = medianCut(pixels, 3).sort((a, b) => b.share - a.share);
  return main?.rgb ?? null;
}

const paletteCache = new Map<string, Promise<TitlePalette | null>>();

function readPalette(source: PaletteSource): Promise<TitlePalette | null> {
  const key = `${source.coverUrl}|${source.logoUrl ?? ""}`;
  let pending = paletteCache.get(key);
  if (!pending) {
    pending = Promise.all([
      coverPalette(source.coverUrl).catch(() => []),
      source.logoUrl
        ? logoColour(source.logoUrl).catch(() => null)
        : Promise.resolve(null),
    ]).then(([cover, logo]) => (cover.length > 0 ? { cover, logo } : null));
    paletteCache.set(key, pending);
  }
  return pending;
}

function paletteSources(items: MediaItem[]): PaletteSource[] {
  const seen = new Set<string>();
  const sources: PaletteSource[] = [];
  for (const item of items) {
    if (!item.ImageTags?.Primary) continue;
    const coverUrl = getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 160);
    if (seen.has(coverUrl)) continue;
    seen.add(coverUrl);
    const logoUrl = item.ImageTags.Logo
      ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 400)
      : item.ParentLogoItemId && item.ParentLogoImageTag
        ? getLogoImageUrl(item.ParentLogoItemId, item.ParentLogoImageTag, 400)
        : null;
    sources.push({ coverUrl, logoUrl });
  }
  if (sources.length <= MAX_TITLES) return sources;
  const step = sources.length / MAX_TITLES;
  return Array.from(
    { length: MAX_TITLES },
    (_, index) => sources[Math.floor(index * step)]!,
  );
}

async function readAllPalettes(
  sources: PaletteSource[],
): Promise<TitlePalette[]> {
  const palettes: (TitlePalette | null)[] = new Array(sources.length).fill(
    null,
  );
  let next = 0;
  const worker = async () => {
    while (next < sources.length) {
      const index = next;
      next += 1;
      palettes[index] = await readPalette(sources[index]!);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(SAMPLE_CONCURRENCY, sources.length) },
      worker,
    ),
  );
  return palettes.filter((palette): palette is TitlePalette => !!palette);
}

/** Paints at the canvas's own device size, so every stripe edge is crisp. */
function paintBarcode(canvas: HTMLCanvasElement, palettes: TitlePalette[]) {
  const { width: cssWidth, height: cssHeight } = canvas.getBoundingClientRect();
  if (cssWidth === 0 || cssHeight === 0) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * scale);
  canvas.height = Math.round(cssHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);

  const swatchGap = Math.max(1, Math.round(SWATCH_GAP * scale));
  const titleGap = Math.max(swatchGap, Math.round(TITLE_GAP * scale));
  const titleWidth = Math.min(
    (canvas.width + titleGap) / palettes.length,
    MAX_TITLE_WIDTH * scale,
  );
  const left = (canvas.width + titleGap - titleWidth * palettes.length) / 2;
  // Only near-black colours are raised, keeping their hue, until their
  // brightest channel reaches the floor; everything else is left exact.
  const fill = (rgb: Rgb) => {
    const brightest = Math.max(...rgb);
    const [r, g, b] =
      brightest >= DARKEST_CHANNEL
        ? rgb
        : brightest < 1
          ? [DARKEST_CHANNEL, DARKEST_CHANNEL, DARKEST_CHANNEL]
          : rgb.map((channel) => (channel * DARKEST_CHANNEL) / brightest);
    return `rgb(${Math.round(r!)} ${Math.round(g!)} ${Math.round(b!)})`;
  };

  palettes.forEach((palette, title) => {
    const start = left + title * titleWidth;
    const end = left + (title + 1) * titleWidth - titleGap;
    const stripes: Swatch[] = palette.logo
      ? [
          ...palette.cover.map((swatch) => ({
            ...swatch,
            share: swatch.share * (1 - LOGO_SHARE),
          })),
          { rgb: palette.logo, share: LOGO_SHARE },
        ]
      : palette.cover;
    let x = start;
    stripes.forEach((stripe, index) => {
      const isLast = index === stripes.length - 1;
      const right = isLast ? end : x + (end - start) * stripe.share;
      const x0 = Math.round(x);
      const x1 = Math.round(right) - (isLast ? 0 : swatchGap);
      if (x1 > x0) {
        context.fillStyle = fill(stripe.rgb);
        context.fillRect(x0, 0, x1 - x0, canvas.height);
      }
      x = right;
    });
  });
}

export function LibraryHeaderArt({
  items,
  compact = false,
}: {
  items: MediaItem[];
  /** The phone's header, whose titles are a quarter as wide. */
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isPainted, setIsPainted] = useState(false);
  const reduceMotion = useReducedMotion();
  const sources = paletteSources(items);
  const sourcesKey = JSON.stringify(sources);

  useEffect(() => {
    let isCurrent = true;
    let observer: ResizeObserver | undefined;
    const wanted = JSON.parse(sourcesKey) as PaletteSource[];
    if (wanted.length === 0) return;
    void readAllPalettes(wanted).then((palettes) => {
      const canvas = canvasRef.current;
      if (!isCurrent || !canvas || palettes.length === 0) return;
      paintBarcode(canvas, palettes);
      setIsPainted(true);
      observer = new ResizeObserver(() => paintBarcode(canvas, palettes));
      observer.observe(canvas);
    });
    return () => {
      isCurrent = false;
      observer?.disconnect();
    };
  }, [sourcesKey]);

  return (
    <div className="library-art library-art--barcode" aria-hidden="true">
      <LibraryBarcodePlaceholder
        compact={compact}
        className={isPainted ? "is-leaving" : undefined}
      />
      <div className="library-art__barcode-fade">
        <div
          className={`library-art__barcode-wipe${
            isPainted ? " is-painted" : ""
          }${reduceMotion ? " is-still" : ""}`}
        >
          <canvas ref={canvasRef} className="library-art__barcode-canvas" />
        </div>
      </div>
    </div>
  );
}

/**
 * The barcode before its colours: shimmering stripes where the bands will
 * be. The page's skeleton shows it, and the page keeps it on until the
 * palettes are read, so skeleton, page and picture are one piece.
 */
export function LibraryBarcodePlaceholder({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`library-art library-art__placeholder${
        compact ? " is-compact" : ""
      }${className ? ` ${className}` : ""}`}
    >
      <div className="library-art__placeholder-fade">
        <div className="shimmer library-art__placeholder-stripes" />
      </div>
    </div>
  );
}
