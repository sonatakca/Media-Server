import "@fontsource-variable/literata/opsz.css";
import "@fontsource-variable/literata/opsz-italic.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ePub, {
  type Book,
  type Contents,
  type Location as EpubLocation,
  type NavItem,
  type Rendition,
} from "epubjs";
import {
  BookCheck,
  Bookmark,
  BookmarkCheck,
  Download,
  ExternalLink,
  ListTree,
  MoreHorizontal,
} from "lucide-react";
import { useParams } from "react-router-dom";
import { BackButton } from "../components/BackButton";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { WatchedStatusButton } from "../components/WatchedStatusButton";
import {
  SegmentedIconToolbar,
  type SegmentedIconToolbarAction,
} from "../components/ui/SegmentedIconToolbar";
import { useLanguage } from "../i18n/LanguageContext";
import {
  getBookFileUrl,
  getPrimaryImageUrl,
  getReaderItem,
} from "../lib/mediaApi";
import { setPageTitle } from "../lib/pageTitle";
import {
  getMediaOwnerRouteForItem,
  shouldOpenReaderForItem,
} from "../lib/routes";
import type { MediaItem } from "../lib/types";
import { describeErrorForUser } from "../lib/userFacingError";
import { isItemCompleted } from "../lib/watchStatus";
import {
  EPUB_STATIC_CSS,
  enhanceSection,
  getBookFontCss,
  getEpubBlocks,
  getEpubThemeCss,
  hyphenateDocument,
  readLiveAccent,
} from "./reader/epubTypography";
import {
  RULER_FADE_MS,
  ReaderBookCover,
  ReaderMargin,
  ReaderContentsDrawer,
  ReaderMoreMenu,
  ReaderSettingsPanel,
} from "./reader/ReaderPanels";
import {
  formatDuration,
  formatPercent,
  splitNumber,
} from "./reader/readerText";
import {
  CHARS_PER_LOCATION,
  EPUB_PREPARATION_TIMEOUT_MS,
  EPUB_REQUEST_CREDENTIALS,
  READER_SETTINGS_KEY,
  SPOTLIGHT_FLOOR,
  clamp,
  flattenToc,
  getFormatLabel,
  getReaderFormat,
  minutesForLocations,
  readBookmarks,
  isReaderPlace,
  readReaderProgress,
  readStoredReaderSettings,
  themePalettes,
  writeBookmarks,
  writeJsonStorage,
  writeReaderProgress,
  type EpubContentView,
  type ReaderBookmark,
  type ReaderPalette,
  type ReaderPlace,
  type ReaderSettings,
} from "./reader/readerModel";
import {
  getBookPosition,
  saveBookPosition,
  type BookPosition,
} from "../lib/bookPositionApi";
import {
  ReadingLight,
  buildBookMap,
  chapterAt,
  locateInBook,
  type BookMap,
} from "./reader/readingLight";

/** The reading light the settings ask for: its floor, its shape and its reach. */
function lightFromSettings(light: ReadingLight, settings: ReaderSettings) {
  light.setLight(
    SPOTLIGHT_FLOOR[settings.spotlight],
    settings.lightShape,
    settings.lightShape === "line"
      ? settings.lineReach
      : settings.paragraphReach,
  );
}

type Panel = "settings" | "contents" | "more" | null;
type TocEntry = NavItem & { depth: number };

interface ReadingState {
  chapterIndex: number;
  location: number;
  minutesLeftInChapter: number;
  bookFraction: number;
}

interface ColumnBox {
  left: number;
  right: number;
  viewport: number;
}

/**
 * Room the right margin needs beside the column: the ruler and its names
 * against the window's edge, with a clear gap to the text. Narrower windows
 * dock the time left at the foot instead.
 */
const MARGIN_ROOM = 264;

function paletteVariables(palette: ReaderPalette): CSSProperties {
  return {
    "--rd-ground": palette.ground,
    "--rd-ink": palette.ink,
    "--rd-ink2": palette.ink2,
    "--rd-ink3": palette.ink3,
    "--rd-ink4": palette.ink4,
    "--rd-hair": palette.hair,
    "--rd-mark": palette.mark,
    "--rd-glass": palette.glass,
    "--rd-glass-solid": palette.glassSolid,
    "--rd-glass-edge": palette.glassEdge,
    "--rd-glass-highlight": palette.glassHighlight,
    "--rd-lift": palette.lift,
    "--rd-selection": palette.selection,
    "--rd-scheme": palette.scheme,
  } as CSSProperties;
}

function glassStyle(palette: ReaderPalette): CSSProperties {
  return {
    backgroundColor: palette.glass,
    color: palette.ink,
    boxShadow: `0 0 0 1px ${palette.glassEdge}, inset 0 1px 0 ${palette.glassHighlight}, 0 8px 28px rgba(0, 0, 0, 0.18)`,
  };
}

function formatFileSize(bytes: number | undefined): string | null {
  if (!bytes || bytes <= 0) {
    return null;
  }

  if (bytes < 1e6) {
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }

  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function buildHtmlDocument(
  html: string,
  settings: ReaderSettings,
  palette: ReaderPalette,
): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      ${getBookFontCss()}
      ${EPUB_STATIC_CSS}
      ${getEpubThemeCss(settings, palette, readLiveAccent())}
      body > * { max-width: ${settings.width}ch; margin-left: auto; margin-right: auto; }
    </style>
  </head>
  <body>${html}</body>
</html>`;
}

function getTextBlocks(content: string): string[] {
  const blocks = content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.length > 0 ? blocks : [content];
}

function getRenditionContents(rendition: Rendition): EpubContentView[] {
  const contents = rendition.getContents() as unknown;

  if (Array.isArray(contents)) {
    return contents.filter(Boolean) as EpubContentView[];
  }

  return contents ? [contents as EpubContentView] : [];
}

function getScrollProgress(scrollElement: HTMLElement): number {
  const maxScroll = scrollElement.scrollHeight - scrollElement.clientHeight;
  return maxScroll > 0 ? clamp(scrollElement.scrollTop / maxScroll, 0, 1) : 0;
}

function getEpubSpineLength(book: Book): number {
  const spine = book.spine as unknown as {
    length?: number;
    spineItems?: unknown[];
  };

  return spine.length ?? spine.spineItems?.length ?? 0;
}

function getEpubProgressFromLocation(
  book: Book,
  location: EpubLocation | null | undefined,
  cfi: string | undefined,
  useGeneratedLocations: boolean,
): number | null {
  if (useGeneratedLocations && cfi) {
    const percentage = book.locations.percentageFromCfi(cfi) as number | null;

    if (typeof percentage === "number" && Number.isFinite(percentage)) {
      return clamp(percentage, 0, 1);
    }
  }

  const start = location?.start;
  const spineLength = getEpubSpineLength(book);

  if (!start || spineLength <= 0) {
    return null;
  }

  const displayedPage = start.displayed?.page ?? 1;
  const displayedTotal = Math.max(1, start.displayed?.total ?? 1);
  const sectionProgress = clamp((displayedPage - 1) / displayedTotal, 0, 1);

  return clamp((start.index + sectionProgress) / spineLength, 0, 1);
}

/**
 * Resolves once the book's scroll height has held still briefly, or after
 * `limitMs`. Sections loaded around a target reflow after epub.js has already
 * scrolled to it: their content hook awaits hyphenation, then fonts land.
 * Timers, not frames, so a background tab still settles.
 */
function waitForLayoutToSettle(
  host: HTMLElement,
  limitMs = 2500,
): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    let lastHeight = -1;
    let stableSince = started;

    const tick = () => {
      const height =
        host.querySelector<HTMLElement>(".epub-container")?.scrollHeight ?? 0;
      const now = performance.now();

      if (height !== lastHeight) {
        lastHeight = height;
        stableSince = now;
      }

      if (now - stableSince >= 300 || now - started >= limitMs) {
        resolve();
        return;
      }

      window.setTimeout(tick, 50);
    };

    tick();
  });
}

/** A place to open the book at, and when the reader was there (ms). */
interface Target {
  cfi: string | null;
  place: ReaderPlace | null;
  readAt: number;
}

/** A place saved this many ms after the reader stops moving goes to the server. */
const POSITION_SEND_DELAY_MS = 1500;
/** How long opening a book waits for the place saved on other devices. */
const POSITION_FETCH_LIMIT_MS = 2000;

/** Two saves of the same place have the same key, so a re-save is not a move. */
function positionKey({
  cfi,
  place,
}: {
  cfi: string | null;
  place: ReaderPlace | null;
}): string {
  return place
    ? `${place.section}:${place.block}:${place.offset}`
    : (cfi ?? "");
}

/**
 * Where the screen stands in the book, as the first block whose bottom is
 * below the top of the scroller and the distance from that block's top to the
 * scroller's top. A CFI names a character, and epub.js displays one at the very
 * top of the screen, so reopening at the CFI alone dropped the space above a
 * chapter opener and landed a few lines away from where the reader had been.
 */
function readPlace(
  scroller: HTMLElement,
  contents: EpubContentView[],
  blocksOf: WeakMap<Document, HTMLElement[]>,
): ReaderPlace | null {
  const top = scroller.getBoundingClientRect().top;
  const ordered = [...contents].sort(
    (a, b) => (a.sectionIndex ?? 0) - (b.sectionIndex ?? 0),
  );

  for (const content of ordered) {
    const frame = content.document.defaultView?.frameElement;
    const blocks = blocksOf.get(content.document);

    if (!frame || !blocks?.length || content.sectionIndex === undefined) {
      continue;
    }

    const frameTop = frame.getBoundingClientRect().top;
    const bottomOf = (index: number) =>
      frameTop + blocks[index].getBoundingClientRect().bottom;

    if (bottomOf(blocks.length - 1) <= top) {
      continue;
    }

    // Blocks run down the page in order, so the first one still showing is
    // found by halving.
    let low = 0;
    let high = blocks.length - 1;

    while (low < high) {
      const middle = (low + high) >> 1;

      if (bottomOf(middle) > top) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    return {
      section: content.sectionIndex,
      block: low,
      offset: Math.round(
        top - (frameTop + blocks[low].getBoundingClientRect().top),
      ),
    };
  }

  return null;
}

/** Scrolls so the screen stands where `readPlace` found it; false if that block is not rendered. */
function returnToPlace(
  scroller: HTMLElement,
  contents: EpubContentView[],
  blocksOf: WeakMap<Document, HTMLElement[]>,
  place: ReaderPlace,
): boolean {
  const content = contents.find(
    (candidate) => candidate.sectionIndex === place.section,
  );
  const frame = content?.document.defaultView?.frameElement;
  const block = content ? blocksOf.get(content.document)?.[place.block] : null;

  if (!frame || !block) {
    return false;
  }

  const blockTop =
    frame.getBoundingClientRect().top + block.getBoundingClientRect().top;
  scroller.scrollTop +=
    blockTop - (scroller.getBoundingClientRect().top - place.offset);

  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

export function BookReaderPage() {
  const { itemId } = useParams<{ itemId?: string }>();
  const { t, language } = useLanguage();
  const [item, setItem] = useState<MediaItem | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(
    readStoredReaderSettings,
  );
  const [panel, setPanel] = useState<Panel>(null);
  const [contentsTab, setContentsTab] = useState<"contents" | "bookmarks">(
    "contents",
  );
  const [chromeHidden, setChromeHidden] = useState(false);
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [bookMap, setBookMap] = useState<BookMap | null>(null);
  const [bookMeta, setBookMeta] = useState({ author: "", language: "" });
  const [reading, setReading] = useState<ReadingState | null>(null);
  const [columnBox, setColumnBox] = useState<ColumnBox | null>(null);
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [currentCfi, setCurrentCfi] = useState<string | null>(null);
  const [currentHref, setCurrentHref] = useState<string | null>(null);
  const [epubReady, setEpubReady] = useState(false);
  const [epubProgress, setEpubProgress] = useState(0);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  // The book on the opening screen: about a quarter of the screen's height,
  // large enough to read as a book in the hand, never a poster.
  const [openingCoverWidth] = useState(() =>
    Math.round(Math.min(232, Math.max(176, window.innerHeight * 0.26))),
  );

  const epubHostRef = useRef<HTMLDivElement | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const bookRef = useRef<Book | null>(null);
  const lightRef = useRef<ReadingLight | null>(null);
  const scheduleFrameRef = useRef<() => void>(() => undefined);
  const measureColumnRef = useRef<() => void>(() => undefined);
  const markerRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef(settings);
  const panelRef = useRef<Panel>(null);
  const languageRef = useRef(language);
  const settingsPanelRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const readerKeyRef = useRef<(event: KeyboardEvent) => void>(() => undefined);

  useLayoutEffect(() => {
    settingsRef.current = settings;
    panelRef.current = panel;
    languageRef.current = language;
  });

  const palette = themePalettes[settings.theme];

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      writeJsonStorage(READER_SETTINGS_KEY, next);
      return next;
    });
  }, []);

  const showChrome = useCallback(() => setChromeHidden(false), []);

  /*
   * The bar comes when it is asked for — the pointer at the top edge, a tap or
   * click on the text that selects nothing, keyboard focus — and goes when
   * reading resumes. Scrolling only ever hides it: bringing it back on every
   * scroll up put chrome over the text exactly when the reader looked back.
   */
  const barRef = useRef<HTMLElement | null>(null);
  const barHoverRef = useRef(false);
  const barHideTimerRef = useRef(0);
  const holdBar = useCallback(() => {
    window.clearTimeout(barHideTimerRef.current);
    barHoverRef.current = true;
    setChromeHidden(false);
  }, []);
  const releaseBar = useCallback((event: ReactPointerEvent) => {
    barHoverRef.current = false;
    if (event.pointerType === "touch") {
      return;
    }
    window.clearTimeout(barHideTimerRef.current);
    barHideTimerRef.current = window.setTimeout(() => {
      if (
        !barHoverRef.current &&
        panelRef.current === null &&
        // Keyboard focus holds the bar; a button merely left focused by a
        // click does not.
        !barRef.current?.querySelector(":focus-visible")
      ) {
        setChromeHidden(true);
      }
    }, 900);
  }, []);
  useEffect(() => () => window.clearTimeout(barHideTimerRef.current), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const togglePanel = useCallback((next: Exclude<Panel, null>) => {
    setPanel((current) => (current === next ? null : next));
    setChromeHidden(false);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadItem() {
      if (!itemId) {
        setItemError(t("reader.missingItemId"));
        return;
      }

      setItem(null);
      setItemError(null);
      setReaderError(null);

      try {
        const nextItem = await getReaderItem(itemId);

        if (isMounted) {
          setItem(nextItem);
        }
      } catch (error) {
        if (isMounted) {
          setItemError(
            describeErrorForUser(error, t, "reader.couldNotLoadItem"),
          );
        }
      }
    }

    void loadItem();

    return () => {
      isMounted = false;
    };
  }, [itemId, t]);

  const format = useMemo(
    () => (item ? getReaderFormat(item) : "fallback"),
    [item],
  );
  const fileUrl = useMemo(() => (item ? getBookFileUrl(item.Id) : ""), [item]);
  const ownerRoute = useMemo(() => {
    if (!item) {
      return "/home";
    }

    const route = getMediaOwnerRouteForItem(item);
    return route.startsWith("/read/") ? "/home" : route;
  }, [item]);

  const coverUrl = item?.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 540)
    : "";
  const isReaderItem = item ? shouldOpenReaderForItem(item) : true;
  const title = item?.Name ?? t("reader.title");
  const isCompleted = item ? isItemCompleted(item) : false;
  const activeItemId = item?.Id;

  useEffect(() => {
    setPageTitle(item ? `${item.Name} · Seyirlik` : "Reader · Seyirlik", {
      canonicalPath: item
        ? `/read/${item.Id}`
        : itemId
          ? `/read/${itemId}`
          : "/read",
      robots: "noindex, nofollow",
    });
  }, [item, itemId]);

  useEffect(() => {
    setToc([]);
    setBookMap(null);
    setBookMeta({ author: "", language: "" });
    setReading(null);
    setColumnBox(null);
    setPanel(null);
    setChromeHidden(false);
    setCurrentCfi(null);
    setCurrentHref(null);
    setEpubReady(false);
    setEpubProgress(0);
    setReaderError(null);
    setTextContent(null);
    setScrollProgress(0);
    setBookmarks(activeItemId ? readBookmarks(activeItemId) : []);
  }, [activeItemId]);

  /* ---------------- EPUB ---------------- */
  useEffect(() => {
    if (
      format !== "epub" ||
      !fileUrl ||
      !epubHostRef.current ||
      !activeItemId
    ) {
      return undefined;
    }

    let isMounted = true;
    const host = epubHostRef.current;
    host.innerHTML = "";
    setEpubReady(false);
    setReaderError(null);

    const book = ePub(fileUrl, {
      openAs: "epub",
      requestCredentials: EPUB_REQUEST_CREDENTIALS,
    });
    const rendition = book.renderTo(host, {
      manager: "continuous",
      width: "100%",
      height: "100%",
      flow: "scrolled-continuous",
      spread: "none",
      resizeOnOrientationChange: true,
    });
    const light = new ReadingLight(host);
    const savedProgress = readReaderProgress(activeItemId);
    const savedPlace = isReaderPlace(savedProgress?.place)
      ? savedProgress.place
      : null;
    // The place this device saved, and the one every device shares, fetched
    // while the book loads; whichever the reader reached last wins.
    const localPosition: Target = {
      cfi: savedProgress?.cfi ?? null,
      place: savedPlace,
      readAt: savedProgress?.readAt ?? savedProgress?.updatedAt ?? 0,
    };
    const remotePosition = getBookPosition(activeItemId).catch(() => null);
    let currentCfiValue = savedProgress?.cfi;
    /** Each section's blocks, in order, once its typography is in. */
    const blocksOf = new WeakMap<Document, HTMLElement[]>();
    // Until the reader is back where they left off, the places epub.js passes
    // through on the way are not written over the saved one. The same holds
    // while catching up with a place read on another device.
    let restoring = true;
    /** The place last saved or taken from another device, and when it was read. */
    let known = { key: "", readAt: 0 };
    /** A place not yet on the server, sent a moment after the reader stops. */
    let unsent: BookPosition | null = null;
    let sendTimer = 0;
    let scrollElement: HTMLElement | null = null;
    let lastScrollTop = 0;
    let frameId = 0;
    let measureTimer = 0;
    let progressFrame = 0;
    let hasLocations = false;
    let navigationToc: TocEntry[] | null = null;
    let map: BookMap | null = null;
    let resolveFirstContent: () => void = () => undefined;
    const firstContent = new Promise<void>((resolve) => {
      resolveFirstContent = resolve;
    });

    bookRef.current = book;
    renditionRef.current = rendition;
    lightRef.current = light;
    lightFromSettings(light, settingsRef.current);
    /**
     * The ruler's marker follows the reading line, but a leap — a new chapter,
     * or a jump across most of this one — fades it out, moves it, and fades it
     * back in, rather than sweeping it the length of the ruler.
     */
    let markerState: {
      element: HTMLElement | null;
      chapterIndex: number;
      fraction: number;
      switching: boolean;
      pending: { top: string; text: string } | null;
    } = {
      element: null,
      chapterIndex: -1,
      fraction: 0,
      switching: false,
      pending: null,
    };
    let markerTimer = 0;

    const placeMarker = (marker: HTMLElement, top: string, text: string) => {
      marker.style.top = top;
      const label = marker.firstElementChild;
      if (label) {
        label.textContent = text;
      }
    };

    const runFrame = () => {
      const position = light.frame();

      if (light.isFading) {
        scheduleFrame();
      }

      if (!position || !map) {
        return;
      }

      const location = locateInBook(map, position);
      const chapterIndex = chapterAt(map, position.sectionIndex);
      const chapter = map.chapters[chapterIndex];
      const chapterFraction = chapter
        ? clamp(
            (location - chapter.start) /
              Math.max(1, chapter.end - chapter.start),
            0,
            1,
          )
        : 0;
      const marker = markerRef.current;

      if (marker) {
        const top = `${chapterFraction * 100}%`;
        const text = formatPercent(chapterFraction, languageRef.current);

        if (marker !== markerState.element) {
          markerState = {
            element: marker,
            chapterIndex,
            fraction: chapterFraction,
            switching: false,
            pending: null,
          };
          placeMarker(marker, top, text);
        } else if (
          markerState.switching ||
          chapterIndex !== markerState.chapterIndex ||
          Math.abs(chapterFraction - markerState.fraction) > 0.25
        ) {
          markerState.pending = { top, text };

          if (!markerState.switching) {
            markerState.switching = true;
            marker.dataset.switching = "true";
            markerTimer = window.setTimeout(() => {
              const pending = markerState.pending;
              marker.style.transition = "none";
              if (pending) {
                placeMarker(marker, pending.top, pending.text);
              }
              void marker.offsetHeight;
              marker.style.transition = "";
              delete marker.dataset.switching;
              markerState.switching = false;
              markerState.pending = null;
            }, RULER_FADE_MS);
          }
        } else {
          placeMarker(marker, top, text);
        }

        markerState.chapterIndex = chapterIndex;
        markerState.fraction = chapterFraction;
      }

      const next: ReadingState = {
        chapterIndex,
        location: Math.round(location),
        minutesLeftInChapter: chapter
          ? minutesForLocations(chapter.end - location)
          : 0,
        bookFraction: clamp(location / map.total, 0, 1),
      };

      setReading((previous) =>
        previous &&
        previous.chapterIndex === next.chapterIndex &&
        previous.location === next.location &&
        previous.minutesLeftInChapter === next.minutesLeftInChapter
          ? previous
          : next,
      );
    };

    const scheduleFrame = () => {
      if (frameId) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        runFrame();
      });
    };

    /** Where the text column sits on screen, for the margin ruler and time left. */
    const measureColumn = () => {
      window.clearTimeout(measureTimer);
      measureTimer = window.setTimeout(() => {
        if (!isMounted) {
          return;
        }

        const content = getRenditionContents(rendition)[0];
        const body = content?.document.body;
        const frame = content?.document.defaultView?.frameElement;

        if (!body || !frame) {
          return;
        }

        const frameRect = frame.getBoundingClientRect();
        const bodyRect = body.getBoundingClientRect();
        const style = content.document.defaultView!.getComputedStyle(body);
        const next: ColumnBox = {
          left: Math.round(
            frameRect.left + bodyRect.left + parseFloat(style.paddingLeft),
          ),
          right: Math.round(
            frameRect.left + bodyRect.right - parseFloat(style.paddingRight),
          ),
          viewport: window.innerWidth,
        };

        setColumnBox((previous) =>
          previous &&
          previous.left === next.left &&
          previous.right === next.right &&
          previous.viewport === next.viewport
            ? previous
            : next,
        );
        scheduleFrame();
      }, 60);
    };

    scheduleFrameRef.current = scheduleFrame;
    measureColumnRef.current = measureColumn;

    const buildMapIfReady = () => {
      if (!isMounted || !hasLocations || !navigationToc) {
        return;
      }

      map = buildBookMap(book, navigationToc);
      setBookMap(map);
      scheduleFrame();
    };

    rendition.hooks.content.register(async (contents: Contents) => {
      const view = contents as unknown as EpubContentView;
      view.addStylesheetCss(getBookFontCss(), "seyirlik-fonts");
      view.addStylesheetCss(EPUB_STATIC_CSS, "seyirlik-static");
      view.addStylesheetCss(
        getEpubThemeCss(
          settingsRef.current,
          themePalettes[settingsRef.current.theme],
          readLiveAccent(),
        ),
        "seyirlik-theme",
      );

      const bookLanguage =
        (book.packaging?.metadata?.language as string | undefined) ?? "";
      const textLanguage = await hyphenateDocument(view.document, bookLanguage);

      // A Turkish book labelled English: the interface's chapter names follow
      // the text, so their capitals are Turkish too.
      if (
        isMounted &&
        /^tr\b/i.test(textLanguage) &&
        !/^tr\b/i.test(bookLanguage)
      ) {
        setBookMeta((meta) =>
          /^tr\b/i.test(meta.language) ? meta : { ...meta, language: "tr" },
        );
      }

      if (!isMounted) {
        return;
      }

      const blocks = getEpubBlocks(view.document);
      enhanceSection(blocks);
      blocksOf.set(view.document, blocks);
      light.add(view.document, view.sectionIndex ?? 0, blocks);
      resolveFirstContent();
      measureColumn();
      scheduleFrame();
    });

    const saveLocation = (location?: EpubLocation | null) => {
      if (!isMounted) {
        return;
      }

      const currentLocation =
        location ??
        (rendition.currentLocation() as unknown as EpubLocation | undefined);
      const nextCfi = currentLocation?.start?.cfi ?? currentCfiValue;
      const nextProgress = getEpubProgressFromLocation(
        book,
        currentLocation,
        nextCfi,
        hasLocations,
      );

      if (currentLocation?.start?.href) {
        setCurrentHref(currentLocation.start.href);
      }

      if (nextProgress === null) {
        return;
      }

      currentCfiValue = nextCfi;
      setCurrentCfi(nextCfi ?? null);
      setEpubProgress(nextProgress);

      // Nobody reads a hidden page: whatever moves it then (a font landing, the
      // book being measured) is not the reader, and must not outrank a place
      // they have since reached on another device.
      if (restoring || document.visibilityState === "hidden") {
        return;
      }

      const scroller = host.querySelector<HTMLElement>(".epub-container");
      const place = scroller
        ? readPlace(scroller, getRenditionContents(rendition), blocksOf)
        : null;
      const key = positionKey({ cfi: nextCfi ?? null, place });
      const readAt = key === known.key ? known.readAt : Date.now();
      writeReaderProgress(activeItemId, {
        ...(nextCfi ? { cfi: nextCfi } : {}),
        scrollRatio: nextProgress,
        place: place ?? undefined,
        readAt,
      });

      if (key !== known.key) {
        known = { key, readAt };
        unsent = {
          cfi: nextCfi ?? null,
          place,
          fraction: nextProgress,
          readAt,
        };
        window.clearTimeout(sendTimer);
        sendTimer = window.setTimeout(sendPosition, POSITION_SEND_DELAY_MS);
      }
    };

    const sendPosition = (options: { keepalive?: boolean } = {}) => {
      window.clearTimeout(sendTimer);
      const position = unsent;

      if (!position) {
        return;
      }

      unsent = null;
      void saveBookPosition(activeItemId, position, options).catch(() => {
        // Offline or refused: keep it for the next send, unless the reader has
        // moved on since, which is newer anyway.
        unsent ??= position;
      });
    };

    const handleScroll = () => {
      scheduleFrame();

      if (scrollElement) {
        const top = scrollElement.scrollTop;
        const delta = top - lastScrollTop;
        lastScrollTop = top;

        if (
          Math.abs(delta) > 4 &&
          panelRef.current === null &&
          !barHoverRef.current
        ) {
          setChromeHidden(true);
        }
      }

      if (!progressFrame) {
        progressFrame = window.setTimeout(() => {
          progressFrame = 0;
          saveLocation();
        }, 180);
      }
    };

    const attachScroll = () => {
      if (!isMounted) {
        return;
      }

      scrollElement = host.querySelector<HTMLElement>(".epub-container");
      scrollElement?.addEventListener("scroll", handleScroll, {
        passive: true,
      });
      lastScrollTop = scrollElement?.scrollTop ?? 0;
      saveLocation();
      measureColumn();
    };

    const handleRelocated = (location: EpubLocation) => {
      currentCfiValue = location.start.cfi;
      saveLocation(location);
    };

    const handleClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const selection = target?.ownerDocument?.getSelection();

      if ((selection && !selection.isCollapsed) || target?.closest?.("a")) {
        return;
      }

      if (panelRef.current !== null) {
        setPanel(null);
        return;
      }

      setChromeHidden((hidden) => !hidden);
    };

    const handleKey = (event: KeyboardEvent) => readerKeyRef.current(event);

    rendition.on("relocated", handleRelocated);
    rendition.on("click", handleClick);
    rendition.on("keydown", handleKey);

    const resizeObserver = new ResizeObserver(() => {
      measureColumn();
      scheduleFrame();
    });
    resizeObserver.observe(host);

    const preparationTimeoutId = window.setTimeout(() => {
      if (isMounted) {
        setReaderError(t("reader.epubTimedOut"));
      }
    }, EPUB_PREPARATION_TIMEOUT_MS);

    void book.loaded.navigation
      .then((navigation) => {
        if (!isMounted) {
          return;
        }

        navigationToc = flattenToc(navigation.toc).slice(0, 240);
        setToc(navigationToc);
        buildMapIfReady();
      })
      .catch(() => undefined);

    void book.loaded.metadata
      .then((metadata) => {
        if (isMounted) {
          setBookMeta({
            author: metadata.creator ?? "",
            language: metadata.language ?? "",
          });
        }
      })
      .catch(() => undefined);

    const backToPlace = (place: ReaderPlace) => {
      const scroller = host.querySelector<HTMLElement>(".epub-container");
      return scroller
        ? returnToPlace(
            scroller,
            getRenditionContents(rendition),
            blocksOf,
            place,
          )
        : false;
    };

    /**
     * Takes the screen to a saved place: its section first, then, once the
     * book's typography has settled (it lands in the content hook, after
     * epub.js has scrolled), the same block at the same distance from the
     * top, which a CFI alone cannot say. Sections loading around it can still
     * shift it, so it is set once more after they settle. Older saves have
     * only a CFI.
     */
    const goTo = async (target: Target, opening: boolean) => {
      const section = target.place
        ? (book.spine.get(target.place.section) as unknown as {
            href?: string;
          } | null)
        : null;
      const start = section?.href ?? target.cfi ?? undefined;
      await rendition.display(start);

      if (opening) {
        await Promise.race([
          firstContent,
          new Promise((resolve) => window.setTimeout(resolve, 2500)),
        ]);
      }

      if (start && isMounted) {
        await waitForLayoutToSettle(host);
      }

      if (target.place && isMounted && backToPlace(target.place)) {
        await waitForLayoutToSettle(host);
        backToPlace(target.place);
      } else if (target.cfi && isMounted) {
        await rendition.display(target.cfi).catch(() => undefined);
      }

      // Known as this screen measures it once there: a place saved on a
      // narrower screen lands a block or a few px apart here, and that must
      // not count as the reader moving, or catching up would save it again
      // as a new reading.
      const scroller = host.querySelector<HTMLElement>(".epub-container");
      const landed = scroller
        ? readPlace(scroller, getRenditionContents(rendition), blocksOf)
        : null;
      known = {
        key: positionKey(landed ? { cfi: null, place: landed } : target),
        readAt: target.readAt,
      };
    };

    /**
     * Back on this page after reading elsewhere: if another device has since
     * saved a later place, the book moves there before anything here is saved.
     */
    let catchingUp = false;
    const catchUp = async () => {
      if (restoring || catchingUp || !isMounted) {
        return;
      }

      catchingUp = true;
      restoring = true;

      try {
        const remote = await getBookPosition(activeItemId).catch(() => null);

        if (
          remote &&
          isMounted &&
          remote.readAt > known.readAt &&
          positionKey(remote) !== known.key
        ) {
          unsent = null;
          window.clearTimeout(sendTimer);
          await goTo(remote, false);
          writeReaderProgress(activeItemId, {
            ...(remote.cfi ? { cfi: remote.cfi } : {}),
            scrollRatio: remote.fraction,
            place: remote.place ?? undefined,
            readAt: remote.readAt,
          });
          scheduleFrame();
        }
      } finally {
        restoring = false;
        catchingUp = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        sendPosition({ keepalive: true });
      } else {
        void catchUp();
      }
    };
    const handlePageHide = () => sendPosition({ keepalive: true });
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pagehide", handlePageHide);

    void (async () => {
      try {
        const remote = await Promise.race([
          remotePosition,
          new Promise<null>((resolve) =>
            window.setTimeout(() => resolve(null), POSITION_FETCH_LIMIT_MS),
          ),
        ]);
        const target =
          remote && remote.readAt > localPosition.readAt
            ? remote
            : localPosition;
        await goTo(target, true);

        restoring = false;
        window.clearTimeout(preparationTimeoutId);

        if (isMounted) {
          setEpubReady(true);
          window.requestAnimationFrame(attachScroll);
        }
      } catch (error: unknown) {
        window.clearTimeout(preparationTimeoutId);

        if (isMounted) {
          setReaderError(describeErrorForUser(error, t, "reader.couldNotOpen"));
        }
      }
    })();

    void book.ready
      .then(() => book.locations.generate(CHARS_PER_LOCATION))
      .then(() => {
        if (!isMounted) {
          return;
        }

        hasLocations = true;
        saveLocation();
        buildMapIfReady();
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
      window.clearTimeout(preparationTimeoutId);
      window.clearTimeout(measureTimer);
      window.clearTimeout(markerTimer);
      window.clearTimeout(progressFrame);
      window.cancelAnimationFrame(frameId);
      // Leaving the book inside the app is leaving it too.
      sendPosition({ keepalive: true });
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("pagehide", handlePageHide);
      resizeObserver.disconnect();
      scrollElement?.removeEventListener("scroll", handleScroll);
      rendition.off("relocated", handleRelocated);
      rendition.off("click", handleClick);
      rendition.off("keydown", handleKey);
      light.clear();
      rendition.destroy();
      book.destroy();
      scheduleFrameRef.current = () => undefined;
      measureColumnRef.current = () => undefined;

      if (renditionRef.current === rendition) {
        renditionRef.current = null;
      }

      if (bookRef.current === book) {
        bookRef.current = null;
      }

      if (lightRef.current === light) {
        lightRef.current = null;
      }
    };
  }, [activeItemId, fileUrl, format, t]);

  // Settings apply live to every rendered section of the book.
  useEffect(() => {
    const rendition = renditionRef.current;

    if (!rendition || format !== "epub") {
      return undefined;
    }

    if (lightRef.current) {
      lightFromSettings(lightRef.current, settings);
    }

    const css = getEpubThemeCss(settings, palette, readLiveAccent());
    getRenditionContents(rendition).forEach((content) =>
      content.addStylesheetCss(css, "seyirlik-theme"),
    );

    // Sections reflow and the iframes resize a moment after the new rules land.
    const timers = [60, 260, 700].map((delay) =>
      window.setTimeout(() => {
        measureColumnRef.current();
        scheduleFrameRef.current();
      }, delay),
    );

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [format, palette, settings]);

  /* ---------------- Plain text, HTML, images ---------------- */
  const shouldFetchText = format === "text" || format === "html";

  useEffect(() => {
    if (!shouldFetchText || !fileUrl) {
      return undefined;
    }

    const controller = new AbortController();
    setTextContent(null);
    setReaderError(null);

    void fetch(fileUrl, {
      headers: {
        Accept:
          format === "html"
            ? "text/html,application/xhtml+xml,text/plain;q=0.8"
            : "text/plain,text/markdown,*/*;q=0.4",
      },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }

        return response.text();
      })
      .then((content) => setTextContent(content))
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setReaderError(describeErrorForUser(error, t, "reader.textLoadFailed"));
      });

    return () => controller.abort();
  }, [fileUrl, format, shouldFetchText, t]);

  const tracksScrollHost =
    format === "text" || format === "image" || format === "fallback";

  useEffect(() => {
    const scrollElement = scrollHostRef.current;

    if (!item || !tracksScrollHost || !scrollElement) {
      return undefined;
    }

    let lastTop = scrollElement.scrollTop;
    const handleScroll = () => {
      const nextProgress = getScrollProgress(scrollElement);
      const delta = scrollElement.scrollTop - lastTop;
      lastTop = scrollElement.scrollTop;

      if (
        Math.abs(delta) > 4 &&
        panelRef.current === null &&
        !barHoverRef.current
      ) {
        setChromeHidden(true);
      }

      setScrollProgress(nextProgress);
      writeReaderProgress(item.Id, { scrollRatio: nextProgress });
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    const saved = readReaderProgress(item.Id)?.scrollRatio;
    const restoreTimer = saved
      ? window.setTimeout(() => {
          const maxScroll =
            scrollElement.scrollHeight - scrollElement.clientHeight;
          scrollElement.scrollTo({ top: Math.max(0, maxScroll * saved) });
        }, 80)
      : 0;

    return () => {
      window.clearTimeout(restoreTimer);
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [item, textContent, tracksScrollHost]);

  /* ---------------- Keyboard ---------------- */
  useLayoutEffect(() => {
    readerKeyRef.current = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditableTarget(event.target)) {
        return;
      }

      if (event.key === "Escape") {
        if (panelRef.current !== null) {
          setPanel(null);
        }
        return;
      }

      if (
        panelRef.current !== null ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const scroller =
        format === "epub"
          ? epubHostRef.current?.querySelector<HTMLElement>(".epub-container")
          : scrollHostRef.current;

      if (!scroller) {
        return;
      }

      const page = scroller.clientHeight * 0.85;
      const step =
        event.key === " " || event.key === "PageDown"
          ? event.shiftKey && event.key === " "
            ? -page
            : page
          : event.key === "PageUp"
            ? -page
            : event.key === "ArrowDown"
              ? 72
              : event.key === "ArrowUp"
                ? -72
                : 0;

      if (step === 0) {
        return;
      }

      event.preventDefault();
      scroller.scrollBy({
        top: step,
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
    };
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => readerKeyRef.current(event);
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  // A pointer press outside an open popover closes it.
  useEffect(() => {
    if (panel !== "settings" && panel !== "more") {
      return undefined;
    }

    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node;

      if (
        settingsPanelRef.current?.contains(target) ||
        menuRef.current?.contains(target) ||
        (target instanceof Element && target.closest(".rd-bar-end"))
      ) {
        return;
      }

      setPanel(null);
    };

    window.addEventListener("pointerdown", handlePointer);
    return () => window.removeEventListener("pointerdown", handlePointer);
  }, [panel]);

  /* ---------------- Navigation and bookmarks ---------------- */
  // Same settle-then-return as opening the book: the first display lands
  // before the sections around the target have taken our typography.
  const navigateTo = useCallback((target: string) => {
    const rendition = renditionRef.current;
    const host = epubHostRef.current;
    setPanel(null);

    if (!rendition || !host) {
      return;
    }

    void rendition
      .display(target)
      .then(() => waitForLayoutToSettle(host))
      .then(() =>
        renditionRef.current === rendition
          ? rendition.display(target)
          : undefined,
      )
      .then(() => scheduleFrameRef.current())
      .catch(() => undefined);
  }, []);

  const spineIndexOf = useCallback((href: string) => {
    const section = bookRef.current?.spine.get(
      href.split("#")[0],
    ) as unknown as { index?: number } | null | undefined;
    return typeof section?.index === "number" ? section.index : null;
  }, []);

  // A book whose contents list has one entry (often "Start") has no chapters
  // to speak of: the ruler and "chapter ends in" would describe the whole book.
  const hasChapters = bookMap ? bookMap.chapters.length >= 2 : toc.length >= 2;
  const currentChapter =
    hasChapters && bookMap && reading && reading.chapterIndex >= 0
      ? bookMap.chapters[reading.chapterIndex]
      : null;
  const fallbackChapterLabel = useMemo(() => {
    const base = currentHref?.split("#")[0];
    if (!base || !hasChapters) {
      return "";
    }
    let label = "";
    toc.forEach((entry) => {
      if (entry.href.split("#")[0] === base) {
        label ||= entry.label;
      }
    });
    return label.trim();
  }, [currentHref, hasChapters, toc]);
  const chapterLabel = currentChapter?.label ?? fallbackChapterLabel;
  const bookFraction =
    format === "epub"
      ? (reading?.bookFraction ?? epubProgress)
      : scrollProgress;

  const isBookmarked = useMemo(
    () =>
      bookmarks.some(
        (bookmark) =>
          (currentCfi !== null && bookmark.cfi === currentCfi) ||
          (bookmark.progress !== null &&
            Math.abs(bookmark.progress - bookFraction) < 0.0025),
      ),
    [bookFraction, bookmarks, currentCfi],
  );

  const toggleBookmark = useCallback(async () => {
    if (!activeItemId || !currentCfi) {
      return;
    }

    if (isBookmarked) {
      const next = bookmarks.filter(
        (bookmark) =>
          bookmark.cfi !== currentCfi &&
          !(
            bookmark.progress !== null &&
            Math.abs(bookmark.progress - bookFraction) < 0.0025
          ),
      );
      setBookmarks(next);
      writeBookmarks(activeItemId, next);
      return;
    }

    let excerpt = "";

    try {
      const range = await bookRef.current?.getRange(currentCfi);
      const node = range?.startContainer;
      const text = (node?.textContent ?? "").replace(/­/g, "");
      excerpt = text
        .slice(
          node?.nodeType === Node.TEXT_NODE ? (range?.startOffset ?? 0) : 0,
        )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
    } catch {
      excerpt = "";
    }

    const bookmark: ReaderBookmark = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      cfi: currentCfi,
      label: splitNumber(chapterLabel).title || title,
      excerpt,
      progress: bookFraction,
      createdAt: Date.now(),
    };
    const next = [...bookmarks, bookmark].sort(
      (a, b) => (a.progress ?? 0) - (b.progress ?? 0),
    );
    setBookmarks(next);
    writeBookmarks(activeItemId, next);
  }, [
    activeItemId,
    bookFraction,
    bookmarks,
    chapterLabel,
    currentCfi,
    isBookmarked,
    title,
  ]);

  const removeBookmark = useCallback(
    (id: string) => {
      if (!activeItemId) {
        return;
      }
      const next = bookmarks.filter((bookmark) => bookmark.id !== id);
      setBookmarks(next);
      writeBookmarks(activeItemId, next);
    },
    [activeItemId, bookmarks],
  );

  /* ---------------- Rendering ---------------- */
  if (itemError) {
    return (
      <main className="min-h-screen bg-black p-4 text-white">
        <div className="mx-auto w-full max-w-3xl py-10">
          <BackButton fallbackTo="/home" className="mb-4" />
          <ErrorMessage
            title={t("reader.readerUnavailable")}
            message={itemError}
          />
        </div>
      </main>
    );
  }

  if (!item) {
    return (
      <main
        className="seyirlik-reader-shell flex items-center justify-center"
        style={paletteVariables(palette)}
      >
        <LoadingSpinner label="" className="text-current opacity-70" />
      </main>
    );
  }

  if (!isReaderItem) {
    return (
      <main className="min-h-screen bg-black p-4 text-white">
        <div className="mx-auto w-full max-w-3xl py-10">
          <BackButton fallbackTo={ownerRoute} className="mb-4" />
          <ErrorMessage
            title={t("reader.readerUnavailable")}
            message={t("reader.notBook")}
          />
        </div>
      </main>
    );
  }

  const glass = glassStyle(palette);
  const inkStyle: CSSProperties = { color: palette.ink };
  const activeItemStyle: CSSProperties = {
    backgroundColor: palette.ink,
    color: palette.ground,
  };
  const chapterNumber = currentChapter
    ? splitNumber(currentChapter.label).number
    : "";
  const nextChapter =
    bookMap && reading
      ? (bookMap.chapters[reading.chapterIndex + 1] ?? null)
      : null;
  const charted =
    format === "epub" &&
    epubReady &&
    currentChapter !== null &&
    reading !== null;
  const marginFits =
    charted &&
    columnBox !== null &&
    columnBox.viewport - columnBox.right >= MARGIN_ROOM;
  // The settings panel and the menu open over the right margin, and on a
  // phone the sheet opens over the foot.
  const marginCovered = panel === "settings" || panel === "more";
  const timeLeftText = reading
    ? formatDuration(reading.minutesLeftInChapter, t)
    : "";
  // Without a margin (phones, narrow windows) the time left docks at the foot
  // of the screen and comes and goes with the bar; the ruler stays away.
  const timeLeftDocked =
    charted && !marginFits && settings.showTimeLeft && !marginCovered;
  const sizeLabel = formatFileSize(item.MediaSources?.[0]?.Size);

  const toolbarActions: SegmentedIconToolbarAction[] = [
    ...(format === "epub"
      ? [
          {
            id: "contents",
            type: "button" as const,
            label: t("reader.contents"),
            icon: <ListTree />,
            active: panel === "contents",
            tooltip: panel !== "contents",
            onClick: () => togglePanel("contents"),
          },
          {
            id: "bookmark",
            type: "button" as const,
            label: isBookmarked
              ? t("reader.removeBookmark")
              : t("reader.addBookmark"),
            icon: isBookmarked ? (
              <BookmarkCheck style={{ color: "var(--accent, #467a6c)" }} />
            ) : (
              <Bookmark />
            ),
            disabled: !currentCfi,
            className: "rd-bookmark-action",
            onClick: () => void toggleBookmark(),
          },
        ]
      : []),
    {
      id: "appearance",
      type: "button",
      label: t("reader.appearance"),
      icon: (
        <span className="rd-aa" aria-hidden="true">
          <span>A</span>
          <span>a</span>
        </span>
      ),
      active: panel === "settings",
      tooltip: panel !== "settings",
      onClick: () => togglePanel("settings"),
    },
    {
      id: "more",
      type: "button",
      label: t("reader.more"),
      icon: <MoreHorizontal />,
      active: panel === "more",
      tooltip: panel !== "more",
      onClick: () => togglePanel("more"),
    },
  ];

  const renderReaderContent = () => {
    if (readerError) {
      return (
        <div className="absolute inset-0 flex items-center justify-center px-4">
          <ErrorMessage
            title={t("reader.readerUnavailable")}
            message={readerError}
            onRetry={() => window.location.reload()}
          />
        </div>
      );
    }

    if (format === "epub") {
      return (
        <div className="seyirlik-epub-viewport absolute inset-0 overflow-hidden">
          <div
            className="rd-preparing"
            style={{ opacity: epubReady ? 0 : 1, pointerEvents: "none" }}
            aria-hidden={epubReady}
          >
            {coverUrl ? (
              <ReaderBookCover item={item} width={openingCoverWidth} />
            ) : (
              <LoadingSpinner label="" className="text-current opacity-70" />
            )}
            <p role="status">{t("reader.preparingBook")}</p>
          </div>
          <div
            ref={epubHostRef}
            className={`h-full w-full ${epubReady ? "seyirlik-reader-fade-in" : "opacity-0"}`}
          />
        </div>
      );
    }

    if (format === "pdf") {
      return (
        <iframe
          title={title}
          src={fileUrl}
          className="seyirlik-reader-fade-in absolute inset-0 h-full w-full border-0 bg-white pt-16"
        />
      );
    }

    if (format === "image") {
      return (
        <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center px-5 pb-10 pt-20 sm:px-8">
            <img
              src={fileUrl}
              alt={title}
              className="seyirlik-reader-fade-in max-h-[calc(100dvh-8rem)] max-w-full rounded-lg object-contain shadow-artwork-glow"
            />
          </div>
        </div>
      );
    }

    if (format === "html") {
      return textContent === null ? (
        <div className="flex h-full items-center justify-center">
          <LoadingSpinner label="" className="text-current opacity-70" />
        </div>
      ) : (
        <iframe
          title={title}
          sandbox=""
          srcDoc={buildHtmlDocument(textContent, settings, palette)}
          className="seyirlik-reader-fade-in absolute inset-0 h-full w-full border-0"
          style={{ background: palette.ground }}
        />
      );
    }

    if (format === "text") {
      return (
        <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
          {textContent === null ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner label="" className="text-current opacity-70" />
            </div>
          ) : (
            <article
              className="rd-plain-text seyirlik-reader-fade-in mx-auto min-h-full px-5 pb-24 pt-20 sm:px-10"
              style={{
                maxWidth: `${settings.width}ch`,
                fontSize: `${settings.fontScale}%`,
                lineHeight: settings.lineHeight,
              }}
            >
              {getTextBlocks(textContent).map((block, index) => (
                <pre
                  key={`${index}-${block.slice(0, 24)}`}
                  className="m-0 mb-[1em] whitespace-pre-wrap break-words font-[inherit]"
                >
                  {block}
                </pre>
              ))}
            </article>
          )}
        </div>
      );
    }

    return (
      <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
        <div className="seyirlik-reader-fade-in mx-auto grid min-h-full w-full max-w-5xl items-center gap-8 px-5 pb-16 pt-24 md:grid-cols-[18rem_1fr]">
          {coverUrl ? (
            <ReaderBookCover
              item={item}
              width={288}
              className="justify-self-center md:justify-self-start"
            />
          ) : (
            <div
              className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-xl p-6 text-center text-xl font-black"
              style={{
                boxShadow: `0 0 0 1px ${palette.hair}`,
                background: palette.ink4,
              }}
            >
              {title}
            </div>
          )}
          <div>
            <p
              className="text-[0.6875rem] font-black uppercase tracking-[0.14em]"
              style={{ color: palette.ink3 }}
            >
              {getFormatLabel(format)}
            </p>
            <h1 className="mt-3 text-3xl font-black sm:text-5xl">
              {t("reader.unsupportedTitle")}
            </h1>
            <p
              className="mt-4 max-w-2xl text-base leading-7"
              style={{ color: palette.ink2 }}
            >
              {t("reader.unsupportedMessage")}
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a
                href={fileUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-black"
                style={activeItemStyle}
              >
                <ExternalLink size={17} />
                {t("reader.openOriginal")}
              </a>
              <a
                href={fileUrl}
                download
                className="inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-black"
                style={glass}
              >
                <Download size={17} />
                {t("reader.downloadBook")}
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <main
      className="seyirlik-reader-shell"
      data-chrome={chromeHidden && panel === null ? "hidden" : "shown"}
      style={paletteVariables(palette)}
      lang={language}
    >
      <div className="rd-stage">{renderReaderContent()}</div>

      <div className="rd-progress" aria-hidden="true">
        <span style={{ transform: `scaleX(${clamp(bookFraction, 0, 1)})` }} />
      </div>

      <div
        className="rd-hover-strip"
        onPointerEnter={showChrome}
        onPointerLeave={releaseBar}
        aria-hidden="true"
      />

      <header
        ref={barRef}
        className="rd-bar"
        onFocusCapture={showChrome}
        onPointerEnter={holdBar}
        onPointerLeave={releaseBar}
      >
        <div className="rd-bar-start">
          <BackButton
            fallbackTo={ownerRoute}
            className="shrink-0 p-[0.05rem]"
            style={glass}
            buttonStyle={inkStyle}
            label=""
            noYShift
          />
        </div>

        <div className="rd-titles" lang={bookMeta.language || undefined}>
          <h1 className="rd-title">{title}</h1>
          {bookMeta.author || chapterLabel ? (
            <div className="rd-subtitle">
              {bookMeta.author ? (
                <span className="rd-subtitle-author">{bookMeta.author}</span>
              ) : null}
              {bookMeta.author && chapterLabel ? (
                <i aria-hidden="true" />
              ) : null}
              {chapterLabel ? (
                <span>{splitNumber(chapterLabel).title}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rd-bar-end">
          <SegmentedIconToolbar
            actions={toolbarActions}
            ariaLabel={t("reader.settings")}
            size="md"
            style={glass}
            itemStyle={inkStyle}
            activeItemStyle={activeItemStyle}
            inactiveItemStyle={inkStyle}
            activeItemClassName="shadow-sm"
            inactiveItemClassName="hover:bg-[var(--rd-ink4)]"
          />
        </div>
      </header>

      {marginFits &&
      currentChapter &&
      (settings.showRuler || settings.showTimeLeft) ? (
        <ReaderMargin
          ref={markerRef}
          chapter={currentChapter}
          next={nextChapter}
          chapterNumber={chapterNumber}
          covered={marginCovered}
          showRuler={settings.showRuler}
          timeLeft={settings.showTimeLeft ? timeLeftText : null}
          bookLanguage={bookMeta.language}
        />
      ) : null}

      {timeLeftDocked ? (
        <div className="rd-timeleft" data-docked>
          {t("reader.toChapterEnd")} <b>≈ {timeLeftText}</b>
        </div>
      ) : null}

      <ReaderSettingsPanel
        ref={settingsPanelRef}
        open={panel === "settings"}
        settings={settings}
        showReadingLight={format === "epub"}
        onChange={updateSettings}
      />

      <ReaderMoreMenu
        ref={menuRef}
        open={panel === "more"}
        fileUrl={fileUrl}
        downloadUrl={fileUrl}
        sizeLabel={
          sizeLabel ? `${getFormatLabel(format)} · ${sizeLabel}` : null
        }
        onClose={closePanel}
        finishedControl={
          <WatchedStatusButton
            scope="item"
            action={isCompleted ? "remove" : "mark"}
            item={item}
            showLabel
            iconSize={18}
            icon={<BookCheck size={18} />}
            label={
              isCompleted
                ? t("reader.markUnfinished")
                : t("reader.markFinished")
            }
            className="rd-menu-item"
            onReset={(items) => {
              const updated = items.find((changed) => changed.Id === item.Id);
              if (updated) {
                setItem(updated);
              }
            }}
          />
        }
      />

      {format === "epub" ? (
        <ReaderContentsDrawer
          open={panel === "contents"}
          tab={contentsTab}
          onTab={setContentsTab}
          title={title}
          author={bookMeta.author}
          item={item}
          toc={toc}
          map={bookMap}
          location={reading?.location ?? null}
          currentHref={currentHref}
          bookmarks={bookmarks}
          spineIndexOf={spineIndexOf}
          onNavigate={navigateTo}
          onRemoveBookmark={removeBookmark}
          onClose={closePanel}
        />
      ) : null}
    </main>
  );
}
