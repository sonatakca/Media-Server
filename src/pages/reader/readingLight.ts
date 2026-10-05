import type { Book, NavItem } from "epubjs";
import {
  DEFAULT_READER_SETTINGS,
  READING_LINE,
  clamp,
  type ReaderLightShape,
} from "./readerModel";

/** One line of a block, in px from the block's top, and the ink it carries. */
interface LitSlot {
  top: number;
  bottom: number;
  value: number;
  /** Where the current fade started, where it is going, and when it began (0: settled). */
  from: number;
  goal: number;
  target: number;
  start: number;
}

interface LitBlock {
  element: HTMLElement;
  top: number;
  bottom: number;
  /** One slot until the block comes near the light and its lines are measured. */
  slots: LitSlot[];
  measured: boolean;
  /** The drop cap's box, lit with the brightest of the lines it stands in. */
  dropCap: { left: number; top: number; width: number; height: number } | null;
  /** The opacity and mask last written, so unchanged ink is not written again. */
  written: string;
  /** Its geometry changed, so its mask is rewritten even if no ink moved. */
  dirty: boolean;
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

/** The ink fades between values the way the block opacity used to: 0.35s, sine in-out. */
const FADE_MS = 350;
const easeSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);

const slot = (top: number, bottom: number, value: number): LitSlot => ({
  top,
  bottom,
  value,
  from: value,
  goal: value,
  target: value,
  start: 0,
});

/**
 * The lines a block is set in, from the boxes of its text. Boxes taller than a
 * line and a half (a drop cap, an inline image) are left out so they do not
 * merge three lines into one; each line's slot reaches halfway into the
 * leading on either side, so the slots tile the block without gaps.
 */
function measureLines(
  element: HTMLElement,
  blockTop: number,
  height: number,
): LitSlot[] {
  const document = element.ownerDocument;
  const view = document.defaultView;
  const style = view?.getComputedStyle(element);
  const lineHeight =
    parseFloat(style?.lineHeight ?? "") ||
    parseFloat(style?.fontSize ?? "16") * 1.5;
  const fontSize = parseFloat(style?.fontSize ?? "16");

  // Set tighter than its own type (a chapter numeral, a display heading), a
  // block's ink overruns its lines, so it is lit as one: stepping it would
  // need a mask, and a mask would crop that ink.
  if (lineHeight < fontSize * 1.15) {
    return [slot(0, height, 1)];
  }

  const scrollY = view?.scrollY ?? 0;
  const range = document.createRange();
  range.selectNodeContents(element);
  const boxes = Array.from(range.getClientRects())
    .filter(
      (box) =>
        box.width > 0 && box.height > 0 && box.height <= lineHeight * 1.6,
    )
    .map((box) => ({
      top: box.top + scrollY - blockTop,
      bottom: box.bottom + scrollY - blockTop,
    }))
    .sort((a, b) => a.top - b.top);
  const rows: Array<{ top: number; bottom: number }> = [];

  for (const box of boxes) {
    const last = rows[rows.length - 1];
    const overlap = last
      ? Math.min(last.bottom, box.bottom) - Math.max(last.top, box.top)
      : 0;

    if (
      last &&
      overlap > Math.min(last.bottom - last.top, box.bottom - box.top) * 0.5
    ) {
      last.top = Math.min(last.top, box.top);
      last.bottom = Math.max(last.bottom, box.bottom);
    } else {
      rows.push({ ...box });
    }
  }

  if (rows.length === 0) {
    return [slot(0, height, 1)];
  }

  return rows.map((row, index) =>
    slot(
      index === 0 ? 0 : (rows[index - 1].bottom + row.top) / 2,
      index === rows.length - 1
        ? height
        : (row.bottom + rows[index + 1].top) / 2,
      1,
    ),
  );
}

/**
 * The drop cap's box, for its own layer of light. An `initial-letter` cap is a
 * pseudo-element, and a range over its character returns a small placeholder
 * box rather than the glyph, so the box is read from the lines the cap
 * indents: from the block's left edge to where those lines' text begins, and
 * from the block's top to the bottom of the last line it spans.
 */
function measureDropCap(
  element: HTMLElement,
  blockTop: number,
  blockLeft: number,
) {
  if (!element.classList.contains("seyirlik-dropcap")) {
    return null;
  }

  const document = element.ownerDocument;
  const view = document.defaultView;
  const letter = view?.getComputedStyle(element, "::first-letter") as
    | (CSSStyleDeclaration & { initialLetter?: string; webkitInitialLetter?: string })
    | undefined;
  const spans = parseInt(letter?.initialLetter || letter?.webkitInitialLetter || "", 10);

  if (!Number.isFinite(spans) || spans < 2) {
    return null;
  }

  const style = view?.getComputedStyle(element);
  const lineHeight =
    parseFloat(style?.lineHeight ?? "") ||
    parseFloat(style?.fontSize ?? "16") * 1.5;
  const scrollY = view?.scrollY ?? 0;
  const range = document.createRange();
  range.selectNodeContents(element);
  // The text lines the cap stands beside: boxes inside the block, one line high.
  const lines = Array.from(range.getClientRects())
    .map((box) => ({
      top: box.top + scrollY - blockTop,
      bottom: box.bottom + scrollY - blockTop,
      left: box.left - blockLeft,
    }))
    .filter((box) => box.top > -1 && box.bottom - box.top <= lineHeight * 1.6)
    .filter((box) => box.top < lineHeight * spans);

  if (lines.length === 0) {
    return null;
  }

  const width = Math.min(...lines.map((box) => box.left));
  const height = Math.max(...lines.map((box) => box.bottom));

  return width > 0 && height > 0 ? { left: 0, top: 0, width, height } : null;
}

const ink = (value: number) => `rgba(0,0,0,${value.toFixed(3)})`;

interface BlockMask {
  image: string;
  /** Per-layer placement, or "" for one layer over the whole block. */
  position: string;
  size: string;
  repeat: string;
}

const flat = (image: string): BlockMask => ({ image, position: "", size: "", repeat: "" });

/**
 * The light on a block as a mask: a hard step at each line's slot edge, which
 * falls in the leading, so every line carries one even ink. Paragraph mode and
 * unmeasured blocks have one slot, a flat mask.
 *
 * A drop cap adds a second layer over the cap's own box. Its placement goes in
 * mask-position / -size / -repeat: written inside mask-image (shorthand syntax)
 * the browser rejects the whole value, and a chapter's first paragraph lost its
 * mask and lit as one block whenever the light touched any of its lines.
 */
function blockMask(block: LitBlock): BlockMask {
  const { slots } = block;

  if (slots.length === 1) {
    return flat(`linear-gradient(${ink(slots[0].value)}, ${ink(slots[0].value)})`);
  }

  const stops = slots
    .map(
      (line) =>
        `${ink(line.value)} ${line.top.toFixed(1)}px, ${ink(line.value)} ${line.bottom.toFixed(1)}px`,
    )
    .join(", ");
  const lines = `linear-gradient(180deg, ${stops})`;

  if (!block.dropCap) {
    return flat(lines);
  }

  const cap = block.dropCap;
  const value = Math.max(
    ...slots
      .filter(
        (line) => line.bottom > cap.top && line.top < cap.top + cap.height,
      )
      .map((line) => line.value),
  );

  return {
    image: `${lines}, linear-gradient(${ink(value)}, ${ink(value)})`,
    position: `0px 0px, ${cap.left.toFixed(1)}px ${cap.top.toFixed(1)}px`,
    size: `100% 100%, ${cap.width.toFixed(1)}px ${cap.height.toFixed(1)}px`,
    repeat: "no-repeat, no-repeat",
  };
}

/** Writes a mask, standard and -webkit- (Safari), or clears it with an empty image. */
function writeMask(element: HTMLElement, mask: BlockMask) {
  const { style } = element;

  for (const prefix of ["", "-webkit-"]) {
    style.setProperty(`${prefix}mask-image`, mask.image);
    style.setProperty(`${prefix}mask-position`, mask.position);
    style.setProperty(`${prefix}mask-size`, mask.size);
    style.setProperty(`${prefix}mask-repeat`, mask.repeat);
  }
}

/**
 * The reading light, and where the reading line falls in the book.
 *
 * The light falls on the paragraph at the reading line (the default) or on the
 * line there: that unit carries full ink and the text around it falls off
 * towards a floor, like the glow of a screen. Each line or paragraph keeps one
 * even ink and fades as a whole when the light moves on, so nothing is ever
 * half-lit and the text never moves.
 *
 * Documents are epub.js iframes sized to their content, so a block's place in
 * the window is its iframe's rect plus an offset inside the document. Offsets
 * are cached per document and re-measured only when the document's height
 * changes; a block's lines are measured only once it comes near the light.
 * Each scroll frame sets the ink each line should carry, eases it there over
 * 0.35s, and writes only the blocks whose ink moved.
 */
export class ReadingLight {
  private readonly documents = new Map<Document, LitDocument>();
  private floor = 1;
  private shape: ReaderLightShape = DEFAULT_READER_SETTINGS.lightShape;
  private reach = DEFAULT_READER_SETTINGS.paragraphReach;
  private fading = false;

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
        slots: [slot(0, 0, 1)],
        measured: false,
        dropCap: null,
        written: "|",
        dirty: false,
      })),
    });
  }

  /**
   * The floor the light falls to (1: no light), what it lights, and how far
   * from the lit line or paragraph it has fallen off, as a share of the
   * viewport.
   */
  setLight(floor: number, shape: ReaderLightShape, reach: number) {
    if (floor === this.floor && shape === this.shape && reach === this.reach) {
      return;
    }

    const reshaped = shape !== this.shape;
    this.floor = floor;
    this.shape = shape;
    this.reach = reach;
    this.documents.forEach((entry) => {
      entry.resting = false;

      if (reshaped) {
        entry.height = -1;
      }
    });
  }

  /** True while some line is still fading towards its ink; the caller runs another frame. */
  get isFading() {
    return this.fading;
  }

  clear() {
    this.documents.clear();
  }

  /** Lights the text for the current scroll position and reports where the reading line is. */
  frame(): ReadingLinePosition | null {
    const view = this.viewport.getBoundingClientRect();
    const line = view.top + view.height * READING_LINE;
    const unlit = this.floor >= 1;
    const byLine = this.shape === "line";
    const span = Math.max(1, view.height * this.reach);
    const now = performance.now();
    let position: ReadingLinePosition | null = null;
    const near: Array<{ block: LitBlock; top: number; entry: LitDocument }> =
      [];
    const visited: Array<{ entry: LitDocument; far: boolean }> = [];
    const stillFading = new Set<LitDocument>();

    this.fading = false;

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
          block.measured = false;
          block.dirty = true;

          if (!byLine || block.slots.length === 1) {
            const value = block.slots[0]?.value ?? 1;
            block.slots = [slot(0, block.bottom - block.top, value)];
            block.dropCap = null;
          }
        }
      }

      const far =
        rect.bottom < view.top - span || rect.top > view.bottom + span;

      if ((far || unlit) && entry.resting) {
        return;
      }

      for (const block of entry.blocks) {
        const top = rect.top + block.top;
        const bottom = rect.top + block.bottom;

        if (unlit) {
          block.slots.forEach((line) => {
            line.target = 1;
          });
          near.push({ block, top, entry });
          continue;
        }

        if (
          byLine &&
          !block.measured &&
          bottom > view.top - span &&
          top < view.bottom + span
        ) {
          // Lines keep the ink they had where they were, so a reflow does not flash.
          const before = block.slots;
          block.slots = measureLines(
            block.element,
            block.top,
            block.bottom - block.top,
          );
          block.slots.forEach((slot) => {
            const middle = (slot.top + slot.bottom) / 2;
            const was =
              before.find((old) => middle >= old.top && middle < old.bottom) ??
              before[before.length - 1];
            slot.value = slot.from = slot.goal = slot.target = was.value;
          });
          block.dirty = true;
          block.dropCap = measureDropCap(
            block.element,
            block.top,
            block.element.getBoundingClientRect().left,
          );
          block.measured = true;
        }

        near.push({ block, top, entry });
      }

      visited.push({ entry, far });
    });

    if (!unlit) {
      // The lit line: the one the reading line falls in, or the nearest one
      // when it falls between blocks.
      let lit = line;
      let nearest = Infinity;

      if (byLine) {
        for (const { block, top } of near) {
          for (const slot of block.slots) {
            const distance = Math.max(
              0,
              top + slot.top - line,
              line - (top + slot.bottom),
            );

            if (distance < nearest) {
              nearest = distance;
              lit = top + (slot.top + slot.bottom) / 2;
            }
          }
        }
      }

      for (const { block, top } of near) {
        for (const slot of block.slots) {
          let t: number;

          if (byLine) {
            const distance = Math.abs(top + (slot.top + slot.bottom) / 2 - lit);
            // Ease-out: the lines beside the lit one already step down, so it
            // reads as one line lit rather than a soft wash.
            const x = Math.min(1, distance / span);
            t = 1 - (1 - x) * (1 - x);
          } else {
            const distance = Math.max(
              0,
              top + slot.top - line,
              line - (top + slot.bottom),
            );
            const x = Math.min(1, distance / span);
            t = x * x * (3 - 2 * x);
          }

          slot.target = 1 - (1 - this.floor) * t;
        }
      }
    }

    for (const { block, entry } of near) {
      let changed = false;

      for (const slot of block.slots) {
        // A new target restarts the fade from wherever the ink is now.
        if (Math.abs(slot.target - slot.goal) > 0.005) {
          slot.from = slot.value;
          slot.goal = slot.target;
          slot.start = now;
        }

        if (slot.start === 0) {
          continue;
        }

        const progress = Math.min(1, (now - slot.start) / FADE_MS);
        slot.value = slot.from + (slot.goal - slot.from) * easeSine(progress);
        changed = true;

        if (progress >= 1) {
          slot.value = slot.goal;
          slot.start = 0;
        } else {
          this.fading = true;
          stillFading.add(entry);
        }
      }

      if (changed || block.dirty) {
        block.dirty = false;
        // One even ink is opacity, as the paragraph light always was. A mask
        // clips everything to the block's box, and a tightly set heading's
        // ink (the dot of an İ) stands above it; only lines that step need one.
        const first = block.slots[0].value;
        const even = block.slots.every(
          (slot) => Math.abs(slot.value - first) < 0.001,
        );
        const mask = even ? flat("") : blockMask(block);
        const opacity = even && first < 0.999 ? first.toFixed(3) : "";
        const written = `${opacity}|${mask.image}|${mask.position}|${mask.size}`;

        if (written !== block.written) {
          block.written = written;
          block.element.style.opacity = opacity;
          writeMask(block.element, mask);
        }
      }
    }

    // A document rests once it is out of the light and none of its lines is
    // still fading there.
    for (const { entry, far } of visited) {
      entry.resting = (far || unlit) && !stillFading.has(entry);
    }

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

function getSpineItems(
  book: Book,
): Array<{ index: number; cfiBase: string; href: string }> {
  const spine = book.spine as unknown as {
    spineItems?: Array<{ index: number; cfiBase: string; href: string }>;
  };

  return spine.spineItems ?? [];
}

function getSpineIndex(book: Book, href: string): number | null {
  const section = book.spine.get(href.split("#")[0]) as unknown as {
    index?: number;
  } | null;

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
      start ??
      (index + 1 < spineItems.length ? sectionStarts[index + 1] : total);
  }

  const topLevel = toc.filter((entry) => entry.depth === 0);
  const entries = topLevel.length >= 2 ? topLevel : toc;
  const located = entries
    .map((entry) => ({ entry, spineIndex: getSpineIndex(book, entry.href) }))
    .filter(
      (
        candidate,
      ): candidate is {
        entry: NavItem & { depth: number };
        spineIndex: number;
      } => candidate.spineIndex !== null,
    )
    .sort((a, b) => a.spineIndex - b.spineIndex);

  const chapters: BookChapter[] = located.map(
    ({ entry, spineIndex }, index) => {
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
    },
  );

  return { total, sectionStarts, chapters };
}

/** The reading line's place in the book, in locations. */
export function locateInBook(
  map: BookMap,
  position: ReadingLinePosition,
): number {
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
