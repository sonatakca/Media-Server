/**
 * The colour that writes a found passage out for the reader, and fades.
 *
 * Opening the book at a search result sends the reader's mark colour across
 * the passage, every line at once, left to right: a column of colour with a
 * bright glint at its front edge. Behind it the letters keep the mark colour,
 * held long enough to be followed, then eased back into the ordinary ink.
 *
 * All of it is the text's own colour: CSS Custom Highlights, as the reader's
 * highlights are. The glint is three brighter tiers of the same colour on the
 * last letters before the front, so it is exact to the letter and nothing
 * behind the letters (ground, margins, the gaps between lines) is ever
 * touched, on any theme.
 *
 * Nothing is written into the book's markup. Saved places, CFIs and
 * highlights are all reckoned against that markup; the colour lives in
 * highlights, a rule in <head> and a clock element appended to <html>,
 * outside <body>, and all of it is gone when the passage is ink again.
 */

export interface ShimmerOptions {
  /** The reader's mark colour on this ground, as `#rrggbb`. */
  mark: string;
  /** The ground's body ink, as `#rrggbb`: what the passage returns to. */
  ink: string;
  scheme: "dark" | "light";
  /** The part of the document on screen, in the document's own px. */
  visible: { top: number; bottom: number };
}

interface Line {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The column takes this long to cross the longest line, glint included,
 * which keeps its front near 11 px a frame at 60 fps, well inside the 32 px
 * the reader's motion keeps to.
 */
const SWEEP_MS = 1_400;
/** At most this many lines are coloured as it crosses: the ones on screen. */
const MOST_LINES = 28;
/** The passage holds the mark colour this long once the column has passed. */
const HOLD_MS = 2_600;
/** Then returns to ink over this long. */
const RETURN_MS = 1_600;
/** With reduced motion the colour comes in without travel, this fast. */
const REDUCED_IN_MS = 450;
/**
 * The glint's tiers, faintest first: where each begins behind the front, in
 * ems, and how far its colour goes from the mark towards the glint colour.
 */
const GLINT = [
  { from: 3.4, toward: 0.3 },
  { from: 2.0, toward: 0.6 },
  { from: 0.9, toward: 0.9 },
] as const;
const FOUND = "seyirlik-search-found";

/** The reader's sine, cubic-bezier(0.37, 0, 0.63, 1), near enough for colour. */
const sine = (t: number) => 0.5 - Math.cos(Math.PI * t) / 2;

type Rgb = [number, number, number];

function rgb(colour: string): Rgb {
  const value = Number.parseInt(colour.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function hex(channels: Rgb): string {
  return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function mix(from: string, to: string, amount: number): string {
  const a = rgb(from);
  const b = rgb(to);
  return hex(a.map((v, i) => Math.round(v + (b[i]! - v) * amount)) as Rgb);
}

/** The same hue at 50% saturation and 56% lightness. */
function luminous(colour: string): string {
  const [red, green, blue] = rgb(colour).map((v) => v / 255) as Rgb;
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  const hue =
    delta === 0
      ? 0
      : max === red
        ? ((((green - blue) / delta) % 6) + 6) % 6
        : max === green
          ? (blue - red) / delta + 2
          : (red - green) / delta + 4;
  const lightness = 0.56;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * 0.5;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const sectors: Rgb[] = [
    [chroma, x, 0],
    [x, chroma, 0],
    [0, chroma, x],
    [0, x, chroma],
    [x, 0, chroma],
    [chroma, 0, x],
  ];
  const m = lightness - chroma / 2;
  return hex(
    sectors[Math.floor(hue) % 6]!.map((v) => Math.round((v + m) * 255)) as Rgb,
  );
}

/**
 * What the glint brightens towards: near white on a dark ground; on paper the
 * mark's hue at mid lightness, lighter than the mark and still well clear of
 * the paper.
 */
function glintOf(mark: string, scheme: "dark" | "light"): string {
  return scheme === "dark" ? mix(mark, "#ffffff", 0.85) : luminous(mark);
}

/** The text position under a point of the frame's viewport. */
function caretAt(
  document: Document,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const legacy = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = document.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = legacy.caretRangeFromPoint?.(x, y);
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null;
}

/** The passage's lines as the text sets them: one box per line, per block. */
function linesOf(blocks: HTMLElement[]): Line[] {
  const lines: Line[] = [];
  for (const block of blocks) {
    const document = block.ownerDocument;
    const walker = document.createTreeWalker(block, 4 /* SHOW_TEXT */);
    const range = document.createRange();
    const blockLines: Line[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue;
        const middle = rect.top + rect.height / 2;
        const line = blockLines.find(
          (candidate) => middle > candidate.top && middle < candidate.bottom,
        );
        if (line) {
          line.left = Math.min(line.left, rect.left);
          line.right = Math.max(line.right, rect.right);
          line.top = Math.min(line.top, rect.top);
          line.bottom = Math.max(line.bottom, rect.bottom);
        } else {
          blockLines.push({
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          });
        }
      }
    }
    lines.push(...blockLines.sort((a, b) => a.top - b.top));
  }
  return lines;
}

type FrameWindow = Window &
  typeof globalThis & {
    CSS: typeof CSS & { highlights?: HighlightRegistry };
    Highlight?: typeof Highlight;
  };

type Caret = { node: Node; offset: number };

function rangeBetween(
  document: Document,
  from: Caret,
  to: Caret,
): Range | null {
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

/**
 * Writes the passage out in colour. Returns a function that takes the colour
 * away at once, for when another passage is opened, the frame is resized or
 * the book closes.
 */
export function shimmerPassage(
  blocks: HTMLElement[],
  { mark, ink, scheme, visible }: ShimmerOptions,
): () => void {
  const document = blocks[0]?.ownerDocument;
  const view = document?.defaultView as FrameWindow | null | undefined;
  const registry = view?.CSS?.highlights;
  const Highlight = view?.Highlight;
  if (!document || !view || !registry || typeof Highlight !== "function")
    return () => undefined;

  // Line boxes are measured against the frame's own viewport, which in the
  // reader's scrolled flow is the whole section, and the text under a point
  // is asked for in the same terms.
  const lines = linesOf(blocks)
    .filter(
      (line) =>
        line.bottom + view.scrollY > visible.top &&
        line.top + view.scrollY < visible.bottom,
    )
    .slice(0, MOST_LINES);
  if (lines.length === 0) return () => undefined;

  const reduced = view.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const em =
    Number.parseFloat(view.getComputedStyle(blocks[0]!).fontSize) || 18;
  const glint = glintOf(mark, scheme);

  // The body of the colour, and the glint's tiers at its front.
  const body = new Highlight();
  const tiers = GLINT.map(() => new Highlight());
  const all = [body, ...tiers];
  const names = [FOUND, ...GLINT.map((_, at) => `${FOUND}-${at + 1}`)];
  all.forEach((highlight, at) => registry.set(names[at]!, highlight));
  const rule = document.createElement("style");
  const tierRules = GLINT.map(
    ({ toward }, at) =>
      `::highlight(${names[at + 1]}) { color: ${mix(mark, glint, toward)} !important; }`,
  ).join("\n");
  let painted = "";
  const paint = (colour: string) => {
    if (colour === painted) return;
    painted = colour;
    rule.textContent = `::highlight(${FOUND}) { color: ${colour} !important; }\n${tierRules}`;
  };
  document.head.append(rule);

  // The column crosses at one pace on every line, so the fronts stay level.
  const widest = Math.max(...lines.map((line) => line.right - line.left));
  const speed = (widest + GLINT[0].from * em) / SWEEP_MS;
  const colourIn = reduced ? REDUCED_IN_MS : SWEEP_MS;
  const total = colourIn + HOLD_MS + RETURN_MS;

  // Every phase runs on one clock, so the column, the hold and the return
  // stay together however the page is paused or slowed.
  const clock = document.createElement("i");
  clock.setAttribute("aria-hidden", "true");
  clock.dataset.seyirlikShimmer = "";
  clock.style.cssText = "position:absolute;width:0;height:0;";
  document.documentElement.append(clock);
  const timeline = clock.animate([{ opacity: 0 }, { opacity: 0 }], {
    duration: total,
  });

  const runs = lines.map((line) => {
    const middle = (line.top + line.bottom) / 2;
    /** The text position at a distance along the line, kept on the line. */
    const at = (offset: number) =>
      caretAt(
        document,
        Math.min(
          Math.max(line.left + offset, line.left + 0.5),
          line.right - 0.5,
        ),
        middle,
      );
    return { width: line.right - line.left, at, start: at(0) };
  });

  /** Each line coloured from its start to the front, the glint on its last letters. */
  const write = (t: number) => {
    all.forEach((highlight) => highlight.clear());
    const front = speed * t;
    for (const { width, at, start } of runs) {
      if (!start || front <= 0) continue;
      if (front - GLINT[0].from * em >= width) {
        // The glint has left the line: all of it is body.
        const end = at(width);
        const range = end && rangeBetween(document, start, end);
        if (range) body.add(range);
        continue;
      }
      // Where the body ends and each tier ends, along the line.
      const stops = [...GLINT.map((tier) => front - tier.from * em), front];
      let from = start;
      stops.forEach((stop, part) => {
        if (stop <= 0) return;
        const to = at(Math.min(stop, width));
        if (!to) return;
        const range = rangeBetween(document, from, to);
        if (range) all[part]!.add(range);
        from = to;
      });
    }
  };

  /** The whole passage in colour, off-screen lines included, while it holds. */
  let wholePassage = false;
  const colourPassage = () => {
    if (wholePassage) return;
    wholePassage = true;
    all.forEach((highlight) => highlight.clear());
    for (const block of blocks) {
      const range = document.createRange();
      range.selectNodeContents(block);
      body.add(range);
    }
  };

  let frame = 0;
  let done = false;
  const putOut = () => {
    if (done) return;
    done = true;
    view.cancelAnimationFrame(frame);
    timeline.cancel();
    clock.remove();
    names.forEach((name) => registry.delete(name));
    rule.remove();
    view.removeEventListener("resize", putOut);
  };

  const tick = () => {
    const t = Number(timeline.currentTime ?? 0);
    if (reduced || t >= colourIn) colourPassage();
    else {
      wholePassage = false;
      write(t);
    }
    // In (with reduced motion), held, then back to ink.
    const returning = (t - colourIn - HOLD_MS) / RETURN_MS;
    paint(
      returning > 0
        ? mix(mark, ink, sine(Math.min(1, returning)))
        : reduced && t < colourIn
          ? mix(ink, mark, sine(t / colourIn))
          : mark,
    );
    frame = view.requestAnimationFrame(tick);
  };
  frame = view.requestAnimationFrame(tick);
  view.addEventListener("resize", putOut);
  void timeline.finished.then(putOut).catch(() => undefined);
  return putOut;
}
