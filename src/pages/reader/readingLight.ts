import type { Book, NavItem } from "epubjs";
import { READING_LINE, SPOTLIGHT_FALLOFF, clamp } from "./readerModel";

/**
 * The reading light: the block at the reading line carries full ink and the
 * text above and below falls off towards a floor, like the glow of a screen.
 *
 * Documents are epub.js iframes sized to their content, so a block's place in
 * the window is its iframe's rect plus an offset inside the document. Offsets
 * are cached per document and re-measured only when the document's height
 * changes (a font or spacing change, an image loading), so each scroll frame
 * reads one rect per document and writes only the opacities that changed.
 */

interface LitBlock {
  element: HTMLElement;
  top: number;
  bottom: number;
  opacity: number;
}

interface LitDocument {
  sectionIndex: number;
  height: number;
  blocks: LitBlock[];
  resting: boolean;
}

export interface ReadingLinePosition {
  sectionIndex: number;
  /** How far through the section the reading line is, 0 to 1. */
  fraction: number;
}

export class ReadingLight {
  private readonly documents = new Map<Document, LitDocument>();
  private floor = 1;

  constructor(private readonly viewport: HTMLElement) {}

  add(document: Document, sectionIndex: number, elements: HTMLElement[]) {
    this.documents.set(document, {
      sectionIndex,
      height: -1,
      resting: false,
      blocks: elements.map((element) => ({
        element,
        top: 0,
        bottom: 0,
        opacity: -1,
      })),
    });
  }

  setFloor(floor: number) {
    if (floor === this.floor) {
      return;
    }

    this.floor = floor;
    this.documents.forEach((entry) => {
      entry.resting = false;
    });
  }

  clear() {
    this.documents.clear();
  }

  /** Lights the text for the current scroll position and reports where the reading line is. */
  frame(): ReadingLinePosition | null {
    const view = this.viewport.getBoundingClientRect();
    const line = view.top + view.height * READING_LINE;
    const span = Math.max(1, view.height * SPOTLIGHT_FALLOFF);
    const unlit = this.floor >= 1;
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

      const height = document.body?.scrollHeight ?? 0;

      if (height !== entry.height) {
        entry.height = height;
        entry.resting = false;
        const scrollY = document.defaultView?.scrollY ?? 0;

        for (const block of entry.blocks) {
          const box = block.element.getBoundingClientRect();
          block.top = box.top + scrollY;
          block.bottom = box.bottom + scrollY;
        }
      }

      const far =
        rect.bottom < view.top - span || rect.top > view.bottom + span;

      if ((far || unlit) && entry.resting) {
        return;
      }

      for (const block of entry.blocks) {
        let opacity = 1;

        if (!unlit) {
          const top = rect.top + block.top;
          const bottom = rect.top + block.bottom;
          const distance = Math.max(0, top - line, line - bottom);
          const t = Math.min(1, distance / span);
          opacity = 1 - (1 - this.floor) * t * t * (3 - 2 * t);
        }

        if (Math.abs(opacity - block.opacity) > 0.01) {
          block.opacity = opacity;
          block.element.style.opacity = unlit ? "" : opacity.toFixed(3);
        }
      }

      entry.resting = far || unlit;
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
