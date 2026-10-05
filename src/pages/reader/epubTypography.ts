import archivoLatinUrl from "@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2?url";
import archivoLatinExtUrl from "@fontsource-variable/archivo/files/archivo-latin-ext-wdth-normal.woff2?url";
import literataLatinItalicUrl from "@fontsource-variable/literata/files/literata-latin-opsz-italic.woff2?url";
import literataLatinUrl from "@fontsource-variable/literata/files/literata-latin-opsz-normal.woff2?url";
import literataLatinExtItalicUrl from "@fontsource-variable/literata/files/literata-latin-ext-opsz-italic.woff2?url";
import literataLatinExtUrl from "@fontsource-variable/literata/files/literata-latin-ext-opsz-normal.woff2?url";
import type { ReaderPalette, ReaderSettings } from "./readerModel";

/**
 * The book's documents live in epub.js iframes, which the app's stylesheet and
 * fonts never reach. Everything a page of the book looks like is therefore
 * built here and injected into each document as it renders.
 */

const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT_RANGE =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

export const BOOK_SERIF =
  '"Seyirlik Literata", Literata, Georgia, "Times New Roman", serif';
export const BOOK_SANS =
  '"Seyirlik Archivo", "Archivo Variable", ui-sans-serif, system-ui, sans-serif';

function absolute(url: string): string {
  return new URL(url, window.location.href).href;
}

function face(
  family: string,
  url: string,
  range: string,
  extra: string,
): string {
  return `@font-face{font-family:"${family}";src:url("${absolute(url)}") format("woff2-variations");unicode-range:${range};font-display:swap;${extra}}`;
}

export function getBookFontCss(): string {
  const literata = "font-weight:200 900;";
  const archivo = "font-weight:100 900;font-stretch:62% 125%;";

  return [
    face("Seyirlik Literata", literataLatinUrl, LATIN_RANGE, `${literata}font-style:normal;`),
    face("Seyirlik Literata", literataLatinExtUrl, LATIN_EXT_RANGE, `${literata}font-style:normal;`),
    face("Seyirlik Literata", literataLatinItalicUrl, LATIN_RANGE, `${literata}font-style:italic;`),
    face("Seyirlik Literata", literataLatinExtItalicUrl, LATIN_EXT_RANGE, `${literata}font-style:italic;`),
    face("Seyirlik Archivo", archivoLatinUrl, LATIN_RANGE, archivo),
    face("Seyirlik Archivo", archivoLatinExtUrl, LATIN_EXT_RANGE, archivo),
  ].join("\n");
}

/** Reads the live accent for use inside iframes, where `var(--accent)` is unset. */
export function readLiveAccent(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent")
      .trim() || "#467a6c"
  );
}

/** epub.js theme rules: the parts of the page that follow the reader's settings. */
export function getEpubThemeRules(
  settings: ReaderSettings,
  palette: ReaderPalette,
  accent: string,
) {
  const family = settings.face === "sans" ? BOOK_SANS : BOOK_SERIF;

  return {
    "html, body": {
      background: `${palette.ground} !important`,
      "color-scheme": palette.scheme,
    },
    body: {
      color: `${palette.ink} !important`,
      "font-family": `${family} !important`,
      // 16px on phones, growing to 19px on a desktop column; `ch` measures
      // follow, so the column widens with it and keeps its measure.
      "font-size": `calc(${settings.fontScale / 100} * clamp(1rem, 0.5rem + 0.9vw, 1.1875rem)) !important`,
      "font-weight": settings.face === "sans" ? "450 !important" : "400 !important",
      "line-height": `${settings.lineHeight} !important`,
      "font-optical-sizing": "auto",
      "font-kerning": "normal",
      margin: "0 auto !important",
      padding:
        "clamp(4.5rem, 10vh, 6.5rem) clamp(1.25rem, 5vw, 3rem) clamp(4rem, 9vh, 6rem) !important",
      "max-width": `${settings.width}ch !important`,
      "text-wrap": "pretty",
      "-webkit-text-size-adjust": "100%",
    },
    "p, li, blockquote, dd, dt": {
      "line-height": `${settings.lineHeight} !important`,
      "font-family": `${family} !important`,
    },
    p: {
      margin: "0 !important",
      "text-indent": "1.35em",
    },
    "h1, h2, h3, h4, h5, h6, .seyirlik-reader-heading-block": {
      color: `${palette.ink} !important`,
      "font-family": `${BOOK_SANS} !important`,
      "font-weight": "800 !important",
      "text-align": "center !important",
      "text-indent": "0 !important",
      "letter-spacing": "-0.005em !important",
      "line-height": "1.15 !important",
      margin: "2.2em auto 0.9em !important",
    },
    "h1, h2": {
      "font-stretch": "78%",
      "font-size": "1.75em !important",
    },
    "h3, h4, h5, h6": {
      "font-size": "1.15em !important",
    },
    ".seyirlik-numeral": {
      "font-size": "5em !important",
      "font-weight": "900 !important",
      "font-stretch": "72% !important",
      "line-height": "0.86 !important",
      "letter-spacing": "-0.02em !important",
      margin: "1.2em auto 0.15em !important",
    },
    ".seyirlik-heading-sub": {
      "font-family": `${BOOK_SERIF} !important`,
      "font-style": "italic !important",
      "font-weight": "400 !important",
      "font-stretch": "100% !important",
      "font-size": "1.45em !important",
      color: `${palette.ink2} !important`,
      "margin-top": "0.35em !important",
    },
    ".seyirlik-opener-end::after": {
      content: '""',
      display: "block",
      width: "36px",
      height: "2px",
      "border-radius": "2px",
      background: accent,
      margin: "1.3em auto 0.6em",
    },
    ".seyirlik-no-indent, .seyirlik-after-heading, .seyirlik-lead": {
      "text-indent": "0 !important",
    },
    ".seyirlik-ragged": {
      "text-align": "start !important",
    },
    ".seyirlik-lead": {
      "font-variant-caps": "all-small-caps",
      "letter-spacing": "0.08em",
      "font-weight": "520 !important",
      "margin-bottom": "0.55em !important",
    },
    // Small-cap glyphs ignore Turkish casing (i becomes a dotless I, "bır");
    // text-transform honours lang="tr" and gives İ.
    ":lang(tr) .seyirlik-lead": {
      "font-variant-caps": "normal",
      "text-transform": "uppercase",
      "font-size": "0.8em",
    },
    a: {
      color: `${palette.mark} !important`,
      "text-decoration-color": palette.ink4,
      "text-underline-offset": "0.2em",
    },
    hr: {
      border: "0 !important",
      height: "1px !important",
      width: "36% !important",
      margin: "2.6em auto !important",
      background: `${palette.ink4} !important`,
    },
    "img, svg, video": {
      "max-width": "100% !important",
      height: "auto !important",
    },
    "::selection": {
      background: palette.selection,
    },
  };
}

/** Rules that do not depend on settings, added once per document. */
export const EPUB_STATIC_CSS = `
@keyframes seyirlikReaderBlockFadeIn {
  from { opacity: 0; transform: translateY(0.6rem); }
}
.seyirlik-reader-block {
  transition: opacity 0.35s cubic-bezier(0.37, 0, 0.63, 1);
  animation: seyirlikReaderBlockFadeIn 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
@supports (initial-letter: 3) or (-webkit-initial-letter: 3) {
  .seyirlik-dropcap::first-letter {
    -webkit-initial-letter: 3;
    initial-letter: 3;
    font-family: ${BOOK_SANS};
    font-weight: 900;
    font-stretch: 78%;
    margin-right: 0.09em;
  }
}
html[data-seyirlik-hyphens="manual"] body { hyphens: manual; -webkit-hyphens: manual; }
html[data-seyirlik-hyphens="auto"] body { hyphens: auto; -webkit-hyphens: auto; }
@media (prefers-reduced-motion: reduce) {
  .seyirlik-reader-block { animation: none; transition: none; }
}
`;

const PRIMARY_BLOCKS = [
  "figure",
  "picture",
  "img",
  "table",
  "blockquote",
  "pre",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
].join(",");

/** The block-level pieces of a document: what fades in, and what the light falls on. */
export function getEpubBlocks(document: Document): HTMLElement[] {
  const primary = Array.from(
    document.querySelectorAll<HTMLElement>(PRIMARY_BLOCKS),
  );
  const fallback = Array.from(
    document.querySelectorAll<HTMLElement>(
      "body div, body section, body article",
    ),
  ).filter((element) => {
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim() ?? "")
      .join("");

    return Boolean(directText) && !element.querySelector(PRIMARY_BLOCKS);
  });
  const candidates = [...primary, ...fallback];
  const candidateSet = new Set(candidates);

  return candidates
    .filter((element) => {
      let parent = element.parentElement;

      while (parent && parent !== document.body) {
        if (candidateSet.has(parent)) {
          return false;
        }

        parent = parent.parentElement;
      }

      return Boolean(
        element.textContent?.trim() || element.matches("img,picture,figure"),
      );
    })
    .sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
}

function blockText(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function numericWeight(element: HTMLElement): number {
  const weight =
    element.ownerDocument.defaultView?.getComputedStyle(element).fontWeight ??
    "";

  if (weight === "bold") {
    return 700;
  }

  return Number(weight) || 400;
}

const CHAPTER_WORDS =
  /\b(chapter|part|book|prologue|epilogue|preface|introduction|contents|acknowledgements?|note on the text|bölüm|bolum|önsöz|onsoz|giriş|giris|içindekiler|icindekiler|sonsöz|sonsoz|kısım|kisim)\b/i;
const HEADING_IDENTITY =
  /(title|heading|chapter|subhead|headline|baslik|başlık|bolum|bölüm|onsoz|önsöz)/i;
const OPENING_IDENTITY = /(first|start|opening|chapter-?open|basi|başı|ilk)/i;

export function isHeadingLike(element: HTMLElement, index: number): boolean {
  if (/^h[1-6]$/i.test(element.tagName)) {
    return true;
  }

  if (
    element.closest("li, nav, aside") ||
    element.matches("img,picture,figure,table,blockquote,pre")
  ) {
    return false;
  }

  const text = blockText(element);

  if (!text || text.length > 90) {
    return false;
  }

  if (CHAPTER_WORDS.test(text)) {
    return true;
  }

  const identity = `${element.id} ${element.className}`;

  // "bolum_basi" is the chapter's first sentence, not its title: a paragraph
  // marked as an opening is text, whatever chapter word its class also carries.
  if (element.tagName.toLowerCase() === "p" && OPENING_IDENTITY.test(identity)) {
    return false;
  }

  if (HEADING_IDENTITY.test(identity)) {
    return true;
  }

  const looksShort =
    index < 12 &&
    text.split(/\s+/).length <= 8 &&
    text.length <= 72 &&
    !/[.!?;,]$/.test(text);

  return looksShort && numericWeight(element) >= 700;
}

/**
 * Gives a rendered section its typographic structure: chapter openers (a
 * numeral over an italic title, closed by a short accent rule), a small-caps
 * lead line and a drop cap where a chapter's text begins, and no indent on
 * centred or right-aligned paragraphs.
 *
 * Openers are only inferred where the evidence is strong: a run of headings at
 * the top of a section, or a first paragraph the book itself marks as an
 * opening. A section that merely starts mid-chapter (calibre splits long
 * chapters into files) gets no drop cap.
 */
export function enhanceSection(blocks: HTMLElement[]): void {
  const view = blocks[0]?.ownerDocument.defaultView;

  blocks.forEach((element, index) => {
    element.classList.add("seyirlik-reader-block");

    if (element.tagName.toLowerCase() === "p" && view) {
      const align = view.getComputedStyle(element).textAlign;

      if (align === "center" || align === "right" || align === "end") {
        element.classList.add("seyirlik-no-indent");
      } else if (align === "justify") {
        element.classList.add("seyirlik-ragged");
      }
    }

    if (index < 12 && isHeadingLike(element, index)) {
      element.classList.add("seyirlik-reader-heading-block");
    }
  });

  let cursor = 0;
  const headingRun: HTMLElement[] = [];

  while (
    cursor < blocks.length &&
    cursor < 12 &&
    blocks[cursor].classList.contains("seyirlik-reader-heading-block")
  ) {
    headingRun.push(blocks[cursor]);
    cursor += 1;
  }

  if (headingRun.length > 0) {
    const [first, ...rest] = headingRun;

    if (blockText(first).length <= 4) {
      first.classList.add("seyirlik-numeral");
      rest[0]?.classList.add("seyirlik-heading-sub");
    }

    headingRun[headingRun.length - 1].classList.add("seyirlik-opener-end");
  }

  const firstText = blocks[cursor];
  const opensChapter =
    headingRun.length > 0 ||
    (firstText !== undefined &&
      OPENING_IDENTITY.test(`${firstText.id} ${firstText.className}`));

  if (!firstText || !opensChapter || firstText.tagName.toLowerCase() !== "p") {
    return;
  }

  firstText.classList.add("seyirlik-after-heading");
  const firstLength = blockText(firstText).length;

  if (firstLength >= 200) {
    firstText.classList.add("seyirlik-dropcap");
    return;
  }

  if (firstLength <= 140) {
    firstText.classList.add("seyirlik-lead");
    const next = blocks[cursor + 1];

    if (next?.tagName.toLowerCase() === "p" && !next.classList.contains("seyirlik-no-indent")) {
      // The text proper starts here: never indented, and a drop cap when the
      // paragraph is long enough to wrap around one.
      next.classList.add("seyirlik-after-heading");

      if (blockText(next).length >= 200) {
        next.classList.add("seyirlik-dropcap");
      }
    }
  }
}

type Hyphenate = (text: string, options?: { minWordLength?: number }) => string;
let turkishHyphenator: Promise<Hyphenate | null> | null = null;

function loadTurkishHyphenator(): Promise<Hyphenate | null> {
  turkishHyphenator ??= import("hyphen/tr")
    .then((module) => module.hyphenateSync as Hyphenate)
    .catch(() => null);

  return turkishHyphenator;
}

/**
 * Turkish publishers' EPUBs often declare `en` (or nothing) as their language.
 * The dotless ı and the soft ğ occur in Turkish text at a rate no other
 * language the library holds comes near, so a section with enough of them is
 * Turkish whatever its package says. Short sections keep the declared language.
 */
export function looksTurkish(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");

  if (letters.length < 400) {
    return false;
  }

  const marks = letters.match(/[ıİğĞ]/g)?.length ?? 0;
  return marks / letters.length > 0.008;
}

/**
 * Browsers ship no Turkish hyphenation dictionary, so `hyphens: auto` does
 * nothing for the library's Turkish books and long agglutinative words leave
 * ragged gaps. For Turkish, soft hyphens are inserted from TeX patterns; any
 * other language is left to the browser's own dictionary.
 */
export async function hyphenateDocument(
  document: Document,
  language: string,
): Promise<void> {
  const root = document.documentElement;

  if (!/^tr\b/i.test(language) && looksTurkish(document.body?.textContent ?? "")) {
    language = "tr";
  }

  if (!/^tr\b/i.test(language)) {
    if (language) {
      root.lang ||= language;
    }
    root.dataset.seyirlikHyphens = "auto";
    return;
  }

  root.lang = "tr";
  const hyphenate = await loadTurkishHyphenator();

  if (!hyphenate || root.dataset.seyirlikHyphens === "manual") {
    if (!hyphenate) {
      root.dataset.seyirlikHyphens = "auto";
    }
    return;
  }

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.parentElement?.closest("h1,h2,h3,h4,h5,h6,pre,code,script,style")
          ? NodeFilter.FILTER_REJECT
          : (node.nodeValue?.length ?? 0) > 5
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP,
    },
  );
  const nodes: Text[] = [];

  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }

  for (const node of nodes) {
    node.nodeValue = hyphenate(node.nodeValue ?? "", { minWordLength: 6 });
  }

  root.dataset.seyirlikHyphens = "manual";
}

/** The settings-dependent rules as one stylesheet, replaced in place on every change. */
export function getEpubThemeCss(
  settings: ReaderSettings,
  palette: ReaderPalette,
  accent: string,
): string {
  return Object.entries(getEpubThemeRules(settings, palette, accent))
    .map(
      ([selector, declarations]) =>
        `${selector}{${Object.entries(declarations as Record<string, string>)
          .map(([property, value]) => `${property}:${value}`)
          .join(";")}}`,
    )
    .join("\n");
}
