import type { Book, NavItem } from "epubjs";
import {
  READING_LINE,
  SPOTLIGHT_FALLOFF,
  SPOTLIGHT_LINES,
  clamp,
} from "./readerModel";

/**
 * The reading light: a band of lines at the reading line carries full ink and
 * the text above and below falls off towards a floor, like the glow of a
 * screen.
 *
 * The band is a fixed number of lines, drawn as a mask over the book's
 * scroller, so it is the same height whatever the paragraph: lighting whole
 * paragraphs made it jump between a sliver and a slab. Being a mask, it costs
 * nothing per scroll frame; the text moves through a light that stays put.
 */
export function spotlightMask(floor: number, lineHeightPx: number): string | null {
  if (floor >= 1) {
    return null;
  }

  const half = Math.max(12, (lineHeightPx * SPOTLIGHT_LINES) / 2);
  const line = READING_LINE * 100;
  const fall = SPOTLIGHT_FALLOFF * 100;
  const ink = (t: number) => {
    // Smoothstep from full ink (t = 0) to the floor (t = 1).
    const eased = t * t * (3 - 2 * t);
    return (1 - (1 - floor) * eased).toFixed(3);
  };
  const steps = [1, 0.75, 0.5, 0.25, 0];
  const above = steps.map(
    (t) => `rgba(0,0,0,${ink(t)}) calc(${line}% - ${half}px - ${(fall * t).toFixed(2)}%)`,
  );
  const below = [...steps]
    .reverse()
    .map(
      (t) => `rgba(0,0,0,${ink(t)}) calc(${line}% + ${half}px + ${(fall * t).toFixed(2)}%)`,
    );

  return `linear-gradient(180deg, rgba(0,0,0,${ink(1)}) 0%, ${above.join(", ")}, ${below.join(", ")}, rgba(0,0,0,${ink(1)}) 100%)`;
}

interface LocatedDocument {
  sectionIndex: number;
}

export interface ReadingLinePosition {
  sectionIndex: number;
  /** How far through the section the reading line is, 0 to 1. */
  fraction: number;
}

/** Where the reading line falls in the book: which section, and how far in. */
export class ReadingLight {
  private readonly documents = new Map<Document, LocatedDocument>();

  constructor(private readonly viewport: HTMLElement) {}

  add(document: Document, sectionIndex: number) {
    this.documents.set(document, { sectionIndex });
  }

  clear() {
    this.documents.clear();
  }

  frame(): ReadingLinePosition | null {
    const view = this.viewport.getBoundingClientRect();
    const line = view.top + view.height * READING_LINE;
    let position: ReadingLinePosition | null = null;

    this.documents.forEach((entry, document) => {
      const frame = document.defaultView?.frameElement as HTMLElement | null;

      if (!frame?.isConnected) {
        this.documents.delete(document);
        return;
      }

      const rect = frame.getBoundingClientRect();

      if (rect.height > 0 && line >= rect.top && line < rect.bottom) {
        position = {
          sectionIndex: entry.sectionIndex,
          fraction: clamp((line - rect.top) / rect.height, 0, 1),
        };
      }
    });

    return position;
  }
}

export interface BookChapter {
  label: string;
  href: string;
  depth: number;
  spineIndex: number;
  start: number;
  end: number;
}

export interface BookMap {
  /** Generated locations in the whole book. */
  total: number;
  /** First location of each spine section. */
  sectionStarts: number[];
  chapters: BookChapter[];
}

function getSpineItems(book: Book): Array<{ index: number; cfiBase: string; href: string }> {
  const spine = book.spine as unknown as {
    spineItems?: Array<{ index: number; cfiBase: string; href: string }>;
  };

  return spine.spineItems ?? [];
}

function getSpineIndex(book: Book, href: string): number | null {
  const section = book.spine.get(href.split("#")[0]) as unknown as
    | { index?: number }
    | null;

  return typeof section?.index === "number" ? section.index : null;
}

/**
 * Maps the book onto its generated locations (roughly 1200 characters each),
 * so a chapter has a length, a reading line has a place in it, and time left
 * can be estimated. Only built once epub.js has generated locations; until
 * then the reader shows no estimate rather than a guessed one.
 */
export function buildBookMap(
  book: Book,
  toc: Array<NavItem & { depth: number }>,
): BookMap | null {
  let locations: string[];

  try {
    locations = JSON.parse(book.locations.save()) as string[];
  } catch {
    return null;
  }

  if (!Array.isArray(locations) || locations.length === 0) {
    return null;
  }

  const spineItems = getSpineItems(book);
  const firstByBase = new Map<string, number>();

  locations.forEach((cfi, index) => {
    const base = cfi.slice("epubcfi(".length, cfi.indexOf("!"));

    if (!firstByBase.has(base)) {
      firstByBase.set(base, index);
    }
  });

  const total = locations.length;
  const sectionStarts = new Array<number>(spineItems.length).fill(total);

  for (let index = spineItems.length - 1; index >= 0; index -= 1) {
    const start = firstByBase.get(spineItems[index].cfiBase);
    sectionStarts[index] =
      start ?? (index + 1 < spineItems.length ? sectionStarts[index + 1] : total);
  }

  const topLevel = toc.filter((entry) => entry.depth === 0);
  const entries = topLevel.length >= 2 ? topLevel : toc;
  const located = entries
    .map((entry) => ({ entry, spineIndex: getSpineIndex(book, entry.href) }))
    .filter(
      (candidate): candidate is { entry: NavItem & { depth: number }; spineIndex: number } =>
        candidate.spineIndex !== null,
    )
    .sort((a, b) => a.spineIndex - b.spineIndex);

  const chapters: BookChapter[] = located.map(({ entry, spineIndex }, index) => {
    const nextSpine = located[index + 1]?.spineIndex;

    return {
      label: entry.label.trim(),
      href: entry.href,
      depth: entry.depth,
      spineIndex,
      start: sectionStarts[spineIndex] ?? total,
      end:
        nextSpine !== undefined ? (sectionStarts[nextSpine] ?? total) : total,
    };
  });

  return { total, sectionStarts, chapters };
}

/** The reading line's place in the book, in locations. */
export function locateInBook(map: BookMap, position: ReadingLinePosition): number {
  const start = map.sectionStarts[position.sectionIndex] ?? 0;
  const end = map.sectionStarts[position.sectionIndex + 1] ?? map.total;

  return start + (end - start) * position.fraction;
}

export function chapterAt(map: BookMap, sectionIndex: number): number {
  let found = -1;

  map.chapters.forEach((chapter, index) => {
    if (chapter.spineIndex <= sectionIndex) {
      found = index;
    }
  });

  return found;
}
