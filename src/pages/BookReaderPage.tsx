import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import ePub, {
  type Book,
  type Location as EpubLocation,
  type NavItem,
  type Rendition,
} from "epubjs";
import {
  Download,
  ExternalLink,
  ListTree,
  PanelRightClose,
  Settings2,
} from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { BackButton } from "../components/BackButton";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { Tooltip } from "../components/ui/Tooltip";
import { WatchedStatusButton } from "../components/WatchedStatusButton";
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
import { isItemCompleted } from "../lib/watchStatus";
import {
  SegmentedIconToolbar,
  type SegmentedIconToolbarAction,
} from "../components/ui/SegmentedIconToolbar";
import {
  glassIconButton,
  glassPillButton,
} from "../components/ui/glassControlStyles";
import {
  EPUB_CONTENT_DIVIDER_STYLES,
  EPUB_PREPARATION_TIMEOUT_MS,
  EPUB_REQUEST_CREDENTIALS,
  EPUB_REVEAL_STYLES,
  FONT_SCALE_STEPS,
  LINE_HEIGHT_STEPS,
  READER_SETTINGS_KEY,
  READER_THEME_LABEL_KEYS,
  WIDTH_STEPS,
  clamp,
  flattenToc,
  getFormatLabel,
  getReaderControlStyle,
  getReaderFormat,
  getThemePreviewControlStyle,
  readReaderProgress,
  readStoredReaderSettings,
  themePalettes,
  writeJsonStorage,
  writeReaderProgress,
  type EpubContentView,
  type ReaderFormat,
  type ReaderPalette,
  type ReaderSettings,
  type ReaderTheme,
} from "./reader/readerModel";

function getEpubThemeRules(
  settings: ReaderSettings,
  palette: (typeof themePalettes)[ReaderTheme],
) {
  return {
    body: {
      color: `${palette.text} !important`,
      background: `${palette.page} !important`,
      "font-family": 'Georgia, "Times New Roman", ui-serif, serif !important',
      "font-size": `${settings.fontScale}% !important`,
      "line-height": `${settings.lineHeight} !important`,
      margin: "0 auto !important",
      padding:
        "clamp(1.5rem, 4vh, 2.5rem) clamp(1.25rem, 6vw, 5rem) clamp(5.5rem, 11vh, 8rem) !important",
      "max-width": `${settings.width}ch !important`,
    },
    "p, li, blockquote": {
      "line-height": `${settings.lineHeight} !important`,
    },
    "h1, h2, h3, h4, h5, h6, .seyirlik-reader-heading-block": {
      color: `${palette.accent} !important`,
      "text-align": "center !important",
      "font-weight": "800 !important",
      "letter-spacing": "0 !important",
      "line-height": "1.18 !important",
    },
    a: {
      color: `${palette.accent} !important`,
    },
    hr: {
      border: "0 !important",
      height: "1px !important",
      width: "70% !important",
      margin: "3em auto 2.2em auto !important",
      background:
        "linear-gradient(to right, transparent, currentColor, transparent) !important",
      opacity: "0.22 !important",
    },
    "h1::before, h2::before": {
      content: '""',
      display: "block !important",
      width: "70% !important",
      height: "1px !important",
      margin: "0 auto 2.4em auto !important",
      background:
        "linear-gradient(to right, transparent, currentColor, transparent) !important",
      opacity: "0.22 !important",
    },
    ".firstHeading::before": {
      display: "none !important",
    },
    "h1 + h1::before, h1 + h2::before, h2 + h1::before, h2 + h2::before": {
      display: "none !important",
    },
    img: {
      "max-width": "100% !important",
      height: "auto !important",
    },
    "html, body": {
      "min-height": "100% !important",
    },
    "::selection": {
      background: "rgba(45, 106, 80, 0.34)",
    },
  };
}

function buildHtmlDocument(
  html: string,
  settings: ReaderSettings,
  palette: (typeof themePalettes)[ReaderTheme],
): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <base target="_blank" />
    <style>
      html {
        background: ${palette.page};
        color: ${palette.text};
      }
      body {
        margin: 0;
        min-height: 100vh;
        box-sizing: border-box;
        padding: clamp(1.5rem, 4vh, 2.5rem) clamp(1.25rem, 6vw, 5rem) clamp(5.5rem, 11vh, 8rem);
        color: ${palette.text};
        background: ${palette.page};
        font-family: Georgia, "Times New Roman", ui-serif, serif;
        font-size: ${settings.fontScale}%;
        line-height: ${settings.lineHeight};
      }
      body > * {
        max-width: ${settings.width}ch;
        margin-left: auto;
        margin-right: auto;
      }
      img, video {
        max-width: 100%;
        height: auto;
      }
      a {
        color: ${palette.accent};
      }
      h1, h2, h3, h4, h5, h6 {
        color: ${palette.accent};
        text-align: center;
        font-weight: 800;
        letter-spacing: 0;
        line-height: 1.18;
        margin: clamp(2rem, 6vh, 4.5rem) auto clamp(1.2rem, 3vh, 2rem);
      }
      @keyframes seyirlikReaderBlockFadeIn {
        from {
          opacity: 0;
          transform: translateY(0.65rem);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      body > * {
        opacity: 0;
        animation: seyirlikReaderBlockFadeIn 520ms ease forwards;
      }
      body > *:nth-child(1) { animation-delay: 40ms; }
      body > *:nth-child(2) { animation-delay: 85ms; }
      body > *:nth-child(3) { animation-delay: 130ms; }
      body > *:nth-child(4) { animation-delay: 175ms; }
      body > *:nth-child(5) { animation-delay: 220ms; }
      body > *:nth-child(n + 6) { animation-delay: 265ms; }
      @media (prefers-reduced-motion: reduce) {
        body > * {
          opacity: 1;
          transform: none;
          animation: none;
        }
      }
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

function getEpubRevealBlocks(document: Document): HTMLElement[] {
  const primaryBlockSelector = [
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
  const primaryBlocks = Array.from(
    document.querySelectorAll<HTMLElement>(primaryBlockSelector),
  );
  const fallbackBlocks = Array.from(
    document.querySelectorAll<HTMLElement>(
      "body div, body section, body article",
    ),
  ).filter((element) => {
    const directText = Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent?.trim() ?? "")
      .join("");

    return Boolean(directText) && !element.querySelector(primaryBlockSelector);
  });
  const candidateBlocks = [...primaryBlocks, ...fallbackBlocks];
  const candidateSet = new Set(candidateBlocks);

  return candidateBlocks.filter((element) => {
    const hasSelectedAncestor = Boolean(
      element.parentElement?.closest(".seyirlik-reader-block"),
    );

    if (hasSelectedAncestor) {
      return false;
    }

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
  });
}

function getNormalizedBlockText(element: HTMLElement): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function getNumericFontWeight(element: HTMLElement): number {
  const computedStyle =
    element.ownerDocument.defaultView?.getComputedStyle(element);
  const fontWeight = computedStyle?.fontWeight ?? "";

  if (fontWeight === "bold") {
    return 700;
  }

  if (fontWeight === "normal") {
    return 400;
  }

  return Number(fontWeight) || 400;
}

function isEpubHeadingLikeBlock(element: HTMLElement, index: number): boolean {
  const tagName = element.tagName.toLowerCase();

  if (/^h[1-6]$/.test(tagName)) {
    return true;
  }

  if (
    element.closest("li, nav, aside") ||
    element.matches("img,picture,figure,table,blockquote,pre")
  ) {
    return false;
  }

  const text = getNormalizedBlockText(element);

  if (!text || text.length > 90) {
    return false;
  }

  if (
    /\b(chapter|part|book|prologue|epilogue|preface|introduction|contents|acknowledgements?|note on the text|bölüm|bolum|önsöz|onsoz|giriş|giris|içindekiler|icindekiler|sonsöz|sonsoz)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  const identity = `${element.id} ${element.className}`.toLowerCase();

  if (
    /(title|heading|chapter|subhead|headline|baslik|başlık|bolum|bölüm|onsoz|önsöz)/i.test(
      identity,
    )
  ) {
    return true;
  }

  const wordCount = text.split(/\s+/).length;
  const looksLikeShortHeading =
    index < 12 && wordCount <= 8 && text.length <= 72 && !/[.!?;,]$/.test(text);

  return looksLikeShortHeading && getNumericFontWeight(element) >= 700;
}

function getRenditionContents(rendition: Rendition): EpubContentView[] {
  const contents = rendition.getContents() as unknown;

  if (Array.isArray(contents)) {
    return contents.filter(Boolean) as EpubContentView[];
  }

  return contents ? [contents as EpubContentView] : [];
}

function injectEpubRevealStyles(rendition: Rendition): void {
  getRenditionContents(rendition).forEach((content) => {
    content.addStylesheetCss(EPUB_REVEAL_STYLES, "seyirlik-reader-reveal");
    content.addStylesheetCss(
      EPUB_CONTENT_DIVIDER_STYLES,
      "seyirlik-reader-content-dividers",
    );
    content.addClass("seyirlik-reader-reveal");
    getEpubRevealBlocks(content.document).forEach((element, index) => {
      element.classList.add("seyirlik-reader-block");
      if (isEpubHeadingLikeBlock(element, index)) {
        element.classList.add("seyirlik-reader-heading-block");
      }
      element.style.animationDelay = `${Math.min(40 + index * 45, 420)}ms`;
    });
  });
}

function getScrollProgress(scrollElement: HTMLElement): number {
  const maxScroll = scrollElement.scrollHeight - scrollElement.clientHeight;
  return maxScroll > 0 ? clamp(scrollElement.scrollTop / maxScroll, 0, 1) : 0;
}

function getScrollPageNumber(scrollElement: HTMLElement): number {
  return Math.max(
    1,
    Math.floor(
      scrollElement.scrollTop / Math.max(1, scrollElement.clientHeight),
    ) + 1,
  );
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
  location?: EpubLocation | null,
  cfi?: string,
  useGeneratedLocations = book.locations.length() > 0,
): number | null {
  if (useGeneratedLocations && cfi) {
    const percentage = book.locations.percentageFromCfi(cfi) as number | null;

    if (typeof percentage === "number" && Number.isFinite(percentage)) {
      return clamp(percentage, 0, 1);
    }
  }

  if (useGeneratedLocations) {
    const percentage = location?.start?.percentage;

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

function getEpubLocationPageNumber(
  book: Book,
  location: EpubLocation | null | undefined,
  cfi: string | undefined,
  progress: number,
  useGeneratedLocations = book.locations.length() > 0,
): number {
  const generatedLocationCount = useGeneratedLocations
    ? book.locations.length()
    : 0;

  if (generatedLocationCount > 0) {
    const locationIndex =
      cfi !== undefined
        ? book.locations.locationFromCfi(cfi)
        : location?.start?.location;

    if (
      typeof locationIndex === "number" &&
      Number.isFinite(locationIndex) &&
      locationIndex >= 0
    ) {
      return locationIndex + 1;
    }

    return Math.round(clamp(progress, 0, 1) * (generatedLocationCount - 1)) + 1;
  }

  const displayedPage = location?.start?.displayed?.page;
  const startIndex = location?.start?.index;

  if (typeof displayedPage === "number" && typeof startIndex === "number") {
    return Math.max(1, startIndex + displayedPage);
  }

  return Math.max(1, Math.round(clamp(progress, 0, 1) * 100));
}

function getNearestStepIndex(values: number[], value: number): number {
  return values.reduce((nearestIndex, nextValue, nextIndex) => {
    const nearestDistance = Math.abs(values[nearestIndex] - value);
    const nextDistance = Math.abs(nextValue - value);

    return nextDistance < nearestDistance ? nextIndex : nearestIndex;
  }, 0);
}

function LineHeightTightIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 7h10" />
      <path d="M7 12h10" />
      <path d="M7 17h10" />
      <path d="M4.1 9.1 3 8 1.9 9.1" />
      <path d="M3 8.25v7.5" />
      <path d="m1.9 14.9 1.1 1.1 1.1-1.1" />
    </svg>
  );
}

function LineHeightLooseIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 5h10" />
      <path d="M7 12h10" />
      <path d="M7 19h10" />
      <path d="M3 5.25v13.5" />
      <path d="m1.9 6.7 1.1-1.45 1.1 1.45" />
      <path d="m1.9 17.3 1.1 1.45 1.1-1.45" />
    </svg>
  );
}

function TextWidthNarrowIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 6h8" />
      <path d="M8 12h8" />
      <path d="M8 18h8" />
      <path d="M4 12h4" />
      <path d="m6 10 2 2-2 2" />
      <path d="M20 12h-4" />
      <path d="m18 10-2 2 2 2" />
    </svg>
  );
}

function TextWidthWideIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6h16" />
      <path d="M4 12h16" />
      <path d="M4 18h16" />
      <path d="M9 12H2.5" />
      <path d="m5 9.75-2.5 2.25L5 14.25" />
      <path d="M15 12h6.5" />
      <path d="m19 9.75 2.5 2.25L19 14.25" />
    </svg>
  );
}

function SizeStepControl({
  label,
  value,
  values,
  surfaceStyle,
  dotStyle,
  decreaseIcon,
  increaseIcon,
  onChange,
}: {
  label: string;
  value: number;
  values: number[];
  surfaceStyle: CSSProperties;
  dotStyle: CSSProperties;
  decreaseIcon?: ReactNode;
  increaseIcon?: ReactNode;
  onChange: (value: number) => void;
}) {
  const activeIndex = getNearestStepIndex(values, value);
  const canDecrease = activeIndex > 0;
  const canIncrease = activeIndex < values.length - 1;
  const updateIndex = (nextIndex: number) => {
    onChange(values[clamp(nextIndex, 0, values.length - 1)]);
  };

  return (
    <div className="w-full max-w-[13rem]">
      <div
        className="relative grid h-10 grid-cols-2 overflow-hidden rounded-full bg-[#171719]/75 text-white/88 shadow-[0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.3),0_10px_35px_rgba(0,0,0,0.28)] backdrop-blur-2xl"
        style={surfaceStyle}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-2 top-2 left-1/2 z-10 w-px -translate-x-1/2 rounded-full bg-current opacity-25"
          style={dotStyle}
        />
        <button
          type="button"
          aria-label={`${label}: decrease`}
          disabled={!canDecrease}
          onClick={() => updateIndex(activeIndex - 1)}
          style={dotStyle}
          className="flex h-full items-center justify-center font-black transition-[background-color,color,opacity,transform] duration-150 ease hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:pointer-events-none disabled:opacity-35 active:scale-[0.98]"
        >
          {decreaseIcon ?? <span className="text-lg leading-none">A</span>}
        </button>
        <button
          type="button"
          aria-label={`${label}: increase`}
          disabled={!canIncrease}
          onClick={() => updateIndex(activeIndex + 1)}
          style={dotStyle}
          className="flex h-full items-center justify-center font-black transition-[background-color,color,opacity,transform] duration-150 ease hover:bg-white/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 disabled:pointer-events-none disabled:opacity-35 active:scale-[0.98]"
        >
          {increaseIcon ?? <span className="text-2xl leading-none">A</span>}
        </button>
      </div>
      <div
        className="mt-2 flex h-2 items-center justify-center gap-1.5"
        style={dotStyle}
        aria-hidden="true"
      >
        {values.map((stepValue, index) => (
          <span
            key={`${stepValue}-${index}`}
            className={`rounded-full transition-[background-color,opacity,transform] duration-150 ${
              index === activeIndex
                ? "h-1.5 w-1.5 bg-current opacity-100"
                : index < activeIndex
                  ? "h-1.5 w-1.5 bg-slate-600 opacity-100"
                  : "h-1.5 w-1.5 bg-slate-600 opacity-100"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function ReaderIconButton({
  label,
  className,
  style,
  disabled,
  children,
  onClick,
}: {
  label: string;
  className: string;
  style?: CSSProperties;
  disabled?: boolean;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        style={style}
        className={`${className} disabled:pointer-events-none disabled:opacity-40`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function BookReaderPage() {
  const { itemId } = useParams<{ itemId?: string }>();
  const { t } = useLanguage();
  const [item, setItem] = useState<MediaItem | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(
    readStoredReaderSettings,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [tocItems, setTocItems] = useState<Array<NavItem & { depth: number }>>(
    [],
  );
  const [epubReady, setEpubReady] = useState(false);
  const [epubProgress, setEpubProgress] = useState(0);
  const [readerError, setReaderError] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [readerPageNumber, setReaderPageNumber] = useState(1);

  const epubHostRef = useRef<HTMLDivElement | null>(null);
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);

  const palette = themePalettes[settings.theme];

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings((currentSettings) => {
      const nextSettings = {
        ...currentSettings,
        ...patch,
      };

      writeJsonStorage(READER_SETTINGS_KEY, nextSettings);
      return nextSettings;
    });
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
            error instanceof Error
              ? error.message
              : t("reader.couldNotLoadItem"),
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
  const downloadUrl = useMemo(
    () => (item ? getBookFileUrl(item.Id) : ""),
    [item],
  );
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
  const progress = format === "epub" ? epubProgress : scrollProgress;
  const isReaderContentReady =
    !readerError &&
    (format === "epub"
      ? epubReady
      : format === "text" || format === "html"
        ? textContent !== null
        : Boolean(item));
  const isCompleted = item ? isItemCompleted(item) : false;

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
    setTocItems([]);
    setTocOpen(false);
    setEpubReady(false);
    setEpubProgress(0);
    setReaderError(null);
    setTextContent(null);
    setScrollProgress(0);
    setReaderPageNumber(1);
  }, [item?.Id]);

  const activeItemId = item?.Id;

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
    const hostElement = epubHostRef.current;
    hostElement.innerHTML = "";
    setEpubReady(false);
    setReaderError(null);

    const book = ePub(fileUrl, {
      openAs: "epub",
      requestCredentials: EPUB_REQUEST_CREDENTIALS,
    });
    const rendition = book.renderTo(hostElement, {
      manager: "continuous",
      width: "100%",
      height: "100%",
      flow: "scrolled-continuous",
      spread: "none",
      resizeOnOrientationChange: true,
    });
    const currentPalette = themePalettes[settings.theme];
    const savedProgress = readReaderProgress(activeItemId);
    let currentCfi = savedProgress?.cfi;
    let epubScrollElement: HTMLElement | null = null;
    let pendingProgressFrame = 0;
    let hasGeneratedEpubLocations = false;

    bookRef.current = book;
    renditionRef.current = rendition;

    rendition.themes.register(
      "seyirlik",
      getEpubThemeRules(settings, currentPalette),
    );
    rendition.themes.select("seyirlik");

    const handleRendered = () => {
      injectEpubRevealStyles(rendition);
    };

    rendition.on("rendered", handleRendered);

    const updateEpubLocationProgress = (location?: EpubLocation | null) => {
      if (!isMounted) {
        return;
      }

      const currentLocation =
        location ??
        (rendition.currentLocation() as unknown as EpubLocation | undefined);
      const nextCfi = currentLocation?.start?.cfi ?? currentCfi;
      const nextProgress = getEpubProgressFromLocation(
        book,
        currentLocation,
        nextCfi,
        hasGeneratedEpubLocations,
      );

      if (nextProgress === null) {
        return;
      }

      currentCfi = nextCfi;
      setEpubProgress(nextProgress);
      setReaderPageNumber(
        getEpubLocationPageNumber(
          book,
          currentLocation,
          nextCfi,
          nextProgress,
          hasGeneratedEpubLocations,
        ),
      );
      writeReaderProgress(
        activeItemId,
        nextCfi
          ? {
              cfi: nextCfi,
              scrollRatio: nextProgress,
            }
          : {
              scrollRatio: nextProgress,
            },
      );
    };

    const handleEpubScroll = () => {
      if (pendingProgressFrame) {
        return;
      }

      pendingProgressFrame = window.requestAnimationFrame(() => {
        pendingProgressFrame = 0;
        updateEpubLocationProgress();
      });
    };

    const attachEpubScrollTracking = () => {
      if (!isMounted) {
        return;
      }

      epubScrollElement =
        hostElement.querySelector<HTMLElement>(".epub-container");

      if (!epubScrollElement) {
        return;
      }

      epubScrollElement.addEventListener("scroll", handleEpubScroll, {
        passive: true,
      });
      updateEpubLocationProgress();
    };

    const handleRelocated = (location: EpubLocation) => {
      if (!isMounted) {
        return;
      }

      currentCfi = location.start.cfi;
      updateEpubLocationProgress(location);
    };

    rendition.on("relocated", handleRelocated);

    const preparationTimeoutId = window.setTimeout(() => {
      if (!isMounted) {
        return;
      }

      setReaderError(t("reader.epubTimedOut"));
    }, EPUB_PREPARATION_TIMEOUT_MS);

    void book.loaded.navigation
      .then((navigation) => {
        if (isMounted) {
          setTocItems(flattenToc(navigation.toc).slice(0, 80));
        }
      })
      .catch(() => undefined);

    void rendition
      .display(savedProgress?.cfi)
      .then(() => {
        window.clearTimeout(preparationTimeoutId);

        if (isMounted) {
          setEpubReady(true);
          injectEpubRevealStyles(rendition);
          window.requestAnimationFrame(attachEpubScrollTracking);
        }
      })
      .catch((error: unknown) => {
        window.clearTimeout(preparationTimeoutId);

        if (isMounted) {
          setReaderError(
            error instanceof Error ? error.message : t("reader.couldNotOpen"),
          );
        }
      });

    void book.ready
      .then(() => book.locations.generate(1200))
      .then(() => {
        hasGeneratedEpubLocations = true;
        updateEpubLocationProgress(
          rendition.location as unknown as EpubLocation | undefined,
        );
      })
      .catch(() => undefined);

    return () => {
      isMounted = false;
      window.clearTimeout(preparationTimeoutId);
      if (pendingProgressFrame) {
        window.cancelAnimationFrame(pendingProgressFrame);
      }
      epubScrollElement?.removeEventListener("scroll", handleEpubScroll);
      rendition.off("rendered", handleRendered);
      rendition.off("relocated", handleRelocated);
      rendition.destroy();
      book.destroy();
      if (bookRef.current === book) {
        bookRef.current = null;
      }
      if (renditionRef.current === rendition) {
        renditionRef.current = null;
      }
    };
  }, [activeItemId, fileUrl, format, t]);

  useEffect(() => {
    const rendition = renditionRef.current;

    if (!rendition || format !== "epub") {
      return;
    }

    rendition.themes.register("seyirlik", getEpubThemeRules(settings, palette));
    rendition.themes.select("seyirlik");
    rendition.themes.fontSize(`${settings.fontScale}%`);
  }, [format, palette, settings]);

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
      .then((content) => {
        setTextContent(content);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setReaderError(
          error instanceof Error ? error.message : t("reader.textLoadFailed"),
        );
      });

    return () => {
      controller.abort();
    };
  }, [fileUrl, format, shouldFetchText, t]);

  const tracksScrollHost =
    format === "text" || format === "image" || format === "fallback";

  useEffect(() => {
    const scrollElement = scrollHostRef.current;

    if (!item || !tracksScrollHost || !scrollElement) {
      return undefined;
    }

    const handleScroll = () => {
      const nextProgress = getScrollProgress(scrollElement);

      setScrollProgress(nextProgress);
      setReaderPageNumber(getScrollPageNumber(scrollElement));
      writeReaderProgress(item.Id, {
        scrollRatio: nextProgress,
      });
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();

    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [item, textContent, tracksScrollHost]);

  useEffect(() => {
    const scrollElement = scrollHostRef.current;

    if (!item || !tracksScrollHost || !scrollElement) {
      return;
    }

    const savedProgress = readReaderProgress(item.Id);

    if (!savedProgress?.scrollRatio) {
      return;
    }

    const savedScrollRatio = savedProgress.scrollRatio;

    const timeoutId = window.setTimeout(() => {
      const maxScroll = scrollElement.scrollHeight - scrollElement.clientHeight;
      scrollElement.scrollTo({
        top: Math.max(0, maxScroll * savedScrollRatio),
        behavior: "auto",
      });
    }, 80);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [item, textContent, tracksScrollHost]);

  const displayTocItem = useCallback((href: string) => {
    void renditionRef.current?.display(href);
    setTocOpen(false);
  }, []);

  const controlClass = palette.control;
  const activeControlClass = palette.activeControl;
  const controlSurfaceStyle = getReaderControlStyle(palette);
  const settingsControlSurfaceStyle = getReaderControlStyle(
    palette,
    false,
    true,
  );
  const activeControlSurfaceStyle = getReaderControlStyle(palette, true);
  const controlTextStyle: CSSProperties = { color: palette.controlText };
  const controlMutedTextStyle: CSSProperties = {
    color: palette.controlMutedText,
  };
  const activeToolbarItemStyle: CSSProperties = {
    backgroundColor: palette.controlActiveBackground,
    color: palette.controlText,
  };
  const controlDotStyle: CSSProperties = { color: palette.controlText };
  const isTopBarPinnedOpen = settingsOpen || tocOpen;
  const topControlVisibility = isTopBarPinnedOpen
    ? "pointer-events-auto opacity-100 transition-opacity duration-150 ease will-change-[opacity]"
    : "pointer-events-auto opacity-100 transition-opacity duration-150 ease will-change-[opacity] sm:pointer-events-none sm:opacity-0 sm:group-hover/reader-nav:pointer-events-auto sm:group-hover/reader-nav:opacity-100";
  const topControlClass = controlClass;
  const readerTopOffsetClass = settingsOpen
    ? "top-[calc(30rem+var(--safe-area-inset-top))] min-[380px]:top-[calc(16.5rem+var(--safe-area-inset-top))] md:top-[calc(10.5rem+var(--safe-area-inset-top))]"
    : "top-[calc(3.1rem+var(--safe-area-inset-top))]";

  const readerNavHeightClass = settingsOpen
    ? "h-[calc(30rem+var(--safe-area-inset-top))] min-[380px]:h-[calc(16.5rem+var(--safe-area-inset-top))] md:h-[calc(10.5rem+var(--safe-area-inset-top))]"
    : "h-[calc(4rem+var(--safe-area-inset-top))]";

  const readerContentRightOffsetClass = tocOpen
    ? "right-0 md:right-96"
    : "right-0";

  const tocPanelTopOffsetClass = readerTopOffsetClass;

  const renderSettingsPanel = () => {
    return (
      <div
        aria-hidden={!settingsOpen}
        className={`mt-1 px-3 pb-6 pt-3 sm:px-6 ${palette.pageBorder} transition-[opacity,transform] duration-[250ms] ease ${
          settingsOpen
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-16 opacity-0"
        }`}
      >
        <div className="mx-auto grid max-w-6xl gap-4 min-[380px]:grid-cols-2 md:grid-cols-[1.2fr_1fr_1fr_1fr]">
          <div className="flex flex-col items-center">
            <p
              className={`mb-2 w-full text-center text-xs font-black uppercase ${palette.muted}`}
              style={controlMutedTextStyle}
            >
              {t("reader.theme")}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {(["night", "sepia"] as ReaderTheme[]).map((theme) => {
                const previewPalette = themePalettes[theme];
                const isActiveTheme = settings.theme === theme;

                return (
                  <button
                    key={theme}
                    type="button"
                    onClick={() => updateSettings({ theme })}
                    className={`${glassPillButton} gap-2 ${
                      isActiveTheme ? "scale-[1.02]" : ""
                    }`}
                    style={getThemePreviewControlStyle(
                      previewPalette,
                      isActiveTheme,
                      true,
                    )}
                  >
                    {t(READER_THEME_LABEL_KEYS[theme])}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col items-center">
            <span
              className={`mb-2 block w-full text-center text-xs font-black uppercase ${palette.muted}`}
              style={controlMutedTextStyle}
            >
              {t("reader.fontSize")}
            </span>
            <SizeStepControl
              label={t("reader.fontSize")}
              value={settings.fontScale}
              values={FONT_SCALE_STEPS}
              surfaceStyle={settingsControlSurfaceStyle}
              dotStyle={controlDotStyle}
              onChange={(fontScale) =>
                updateSettings({
                  fontScale,
                })
              }
            />
          </div>

          <div className="flex flex-col items-center">
            <span
              className={`mb-2 block w-full text-center text-xs font-black uppercase ${palette.muted}`}
              style={controlMutedTextStyle}
            >
              {t("reader.lineHeight")}
            </span>
            <SizeStepControl
              label={t("reader.lineHeight")}
              value={settings.lineHeight}
              values={LINE_HEIGHT_STEPS}
              surfaceStyle={controlSurfaceStyle}
              dotStyle={controlDotStyle}
              decreaseIcon={<LineHeightTightIcon />}
              increaseIcon={<LineHeightLooseIcon />}
              onChange={(lineHeight) =>
                updateSettings({
                  lineHeight,
                })
              }
            />
          </div>

          <div className="flex flex-col items-center">
            <span
              className={`mb-2 block w-full text-center text-xs font-black uppercase ${palette.muted}`}
              style={controlMutedTextStyle}
            >
              {t("reader.pageWidth")}
            </span>
            <SizeStepControl
              label={t("reader.pageWidth")}
              value={settings.width}
              values={WIDTH_STEPS}
              surfaceStyle={controlSurfaceStyle}
              dotStyle={controlDotStyle}
              decreaseIcon={<TextWidthNarrowIcon />}
              increaseIcon={<TextWidthWideIcon />}
              onChange={(width) =>
                updateSettings({
                  width,
                })
              }
            />
          </div>
        </div>
      </div>
    );
  };

  const renderTocPanel = () => {
    return (
      <aside
        aria-hidden={!tocOpen}
        className={`pointer-events-auto fixed bottom-0 right-0 z-50 flex w-full max-w-sm flex-col p-4 transition-[top,transform] duration-[250ms] ease will-change-[top,transform] ${tocPanelTopOffsetClass} ${
          tocOpen ? "translate-x-0" : "translate-x-full"
        }`}
        style={{
          backgroundColor: palette.page,
          color: palette.text,
        }}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-black uppercase">
            {t("reader.chapters")}
          </h2>

          <ReaderIconButton
            label={t("reader.closeChapters")}
            className={glassIconButton}
            style={controlSurfaceStyle}
            onClick={() => setTocOpen(false)}
          >
            <PanelRightClose size={18} />
          </ReaderIconButton>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          {tocItems.length > 0 ? (
            <div className="space-y-1">
              {tocItems.map((tocItem, index) => (
                <button
                  key={`${tocItem.href}-${index}`}
                  type="button"
                  onClick={() => displayTocItem(tocItem.href)}
                  className={`block w-full rounded-lg px-3 py-2 text-left text-sm font-semibold transition-opacity hover:opacity-70 ${
                    tocItem.depth > 0 ? "text-xs opacity-78" : ""
                  }`}
                  style={{
                    paddingLeft: `${0.75 + tocItem.depth * 0.85}rem`,
                  }}
                >
                  {tocItem.label}
                </button>
              ))}
            </div>
          ) : (
            <p className={`text-sm ${palette.muted}`}>
              {t("reader.noChapters")}
            </p>
          )}
        </div>
      </aside>
    );
  };

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
        <div className="absolute inset-0">
          <div
            className="seyirlik-epub-viewport h-full w-full overflow-hidden"
            style={{ background: palette.page }}
          >
            {!epubReady ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center">
                <LoadingSpinner label="" className="text-current opacity-70" />
              </div>
            ) : null}
            <div
              ref={epubHostRef}
              className={`h-full w-full ${epubReady ? "seyirlik-reader-fade-in" : "opacity-0"}`}
            />
          </div>
        </div>
      );
    }

    if (format === "pdf") {
      return (
        <div className="absolute inset-0" style={{ background: palette.page }}>
          <iframe
            title={title}
            src={fileUrl}
            className="seyirlik-reader-fade-in h-full w-full border-0 bg-white"
          />
        </div>
      );
    }

    if (format === "image") {
      return (
        <div className="absolute inset-0" style={{ background: palette.page }}>
          <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center px-5 pb-[calc(6.5rem+var(--safe-area-inset-bottom))] pt-6 sm:px-8">
              <img
                src={fileUrl}
                alt={title}
                className="seyirlik-reader-fade-in max-h-[calc(100dvh-13rem)] max-w-full rounded-lg object-contain shadow-artwork-glow"
              />
            </div>
          </div>
        </div>
      );
    }

    if (format === "html") {
      return (
        <div className="absolute inset-0" style={{ background: palette.page }}>
          {!textContent ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner label="" className="text-current opacity-70" />
            </div>
          ) : (
            <iframe
              title={title}
              sandbox=""
              srcDoc={buildHtmlDocument(textContent, settings, palette)}
              className="seyirlik-reader-fade-in h-full w-full border-0"
              style={{ background: palette.page }}
            />
          )}
        </div>
      );
    }

    if (format === "text") {
      return (
        <div className="absolute inset-0" style={{ background: palette.page }}>
          <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
            {!textContent ? (
              <div className="flex h-full items-center justify-center">
                <LoadingSpinner label="" className="text-current opacity-70" />
              </div>
            ) : (
              <article
                className="seyirlik-reader-block-reveal mx-auto min-h-full px-5 pb-[calc(6.5rem+var(--safe-area-inset-bottom))] pt-6 sm:px-10"
                style={{
                  maxWidth: `${settings.width}ch`,
                  background: palette.page,
                  color: palette.text,
                  fontSize: `${settings.fontScale}%`,
                  lineHeight: settings.lineHeight,
                }}
              >
                {getTextBlocks(textContent).map((block, index) => (
                  <pre
                    key={`${index}-${block.slice(0, 24)}`}
                    className="m-0 whitespace-pre-wrap break-words font-serif"
                  >
                    {block}
                  </pre>
                ))}
              </article>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="absolute inset-0" style={{ background: palette.page }}>
        <div ref={scrollHostRef} className="absolute inset-0 overflow-y-auto">
          <div className="seyirlik-reader-block-reveal mx-auto grid min-h-full w-full max-w-5xl items-center gap-8 px-5 pb-[calc(6.5rem+var(--safe-area-inset-bottom))] pt-6 md:grid-cols-[18rem_1fr]">
            <div
              className={`aspect-[2/3] overflow-hidden rounded-lg border ${palette.pageBorder}`}
              style={{ background: palette.page }}
            >
              {coverUrl ? (
                <img
                  src={coverUrl}
                  alt={title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center p-6 text-center text-xl font-black">
                  {title}
                </div>
              )}
            </div>
            <div>
              <p className={`text-sm font-black uppercase ${palette.muted}`}>
                {getFormatLabel(format)}
              </p>
              <h1 className="mt-3 text-3xl font-black sm:text-5xl">
                {t("reader.unsupportedTitle")}
              </h1>
              <p
                className={`mt-4 max-w-2xl text-base leading-7 ${palette.muted}`}
              >
                {t("reader.unsupportedMessage")}
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className={`${activeControlClass} min-h-11 gap-2`}
                  style={activeControlSurfaceStyle}
                >
                  <ExternalLink size={17} />
                  {t("reader.openOriginal")}
                </a>
                <a
                  href={downloadUrl}
                  className={`${controlClass} min-h-11 gap-2`}
                  style={controlSurfaceStyle}
                >
                  <Download size={17} />
                  {t("reader.downloadBook")}
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

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
        className={`flex min-h-screen items-center justify-center ${palette.shell}`}
        style={{ backgroundColor: palette.page, color: palette.text }}
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

  const readerToolbarActions: SegmentedIconToolbarAction[] = [
    ...(tocItems.length > 0
      ? [
          {
            id: "chapters",
            type: "button" as const,
            label: t("reader.chapters"),
            icon: <ListTree />,
            active: tocOpen,
            className: "hidden sm:inline-flex",
            onClick: () => {
              setTocOpen((isOpen) => !isOpen);
            },
          },
        ]
      : []),
    {
      id: "watched-status",
      type: "custom",
      label: isCompleted
        ? t("details.removeWatchedStatus")
        : t("reader.markFinished"),
      active: isCompleted,
      className: "hidden sm:inline-flex",
      render: (className, style) => (
        <WatchedStatusButton
          scope="item"
          action={isCompleted ? "remove" : "mark"}
          item={item}
          label={
            isCompleted
              ? t("details.removeWatchedStatus")
              : t("reader.markFinished")
          }
          onReset={(items) => {
            const updatedItem = items.find(
              (changedItem) => changedItem.Id === item.Id,
            );

            if (updatedItem) {
              setItem(updatedItem);
            }
          }}
          className={className}
          style={style}
        />
      ),
    },
    {
      id: "open-original",
      type: "anchor",
      label: t("reader.openOriginal"),
      href: fileUrl,
      target: "_blank",
      icon: <ExternalLink />,
      className: "hidden sm:inline-flex",
    },
    {
      id: "download",
      type: "anchor",
      label: t("reader.downloadBook"),
      href: downloadUrl,
      icon: <Download />,
    },
    {
      id: "settings",
      type: "button",
      label: t("reader.settings"),
      icon: <Settings2 />,
      active: settingsOpen,
      onClick: () => {
        setSettingsOpen((isOpen) => !isOpen);
      },
    },
  ];

  return (
    <main
      className={`seyirlik-reader-shell relative h-dvh overflow-hidden ${palette.shell}`}
      style={
        {
          "--accent": palette.accent,
          backgroundColor: palette.page,
          color: palette.text,
        } as CSSProperties
      }
    >
      <style>{`
    .seyirlik-reader-shell .seyirlik-epub-viewport .epub-container {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }

    .seyirlik-reader-shell .seyirlik-epub-viewport .epub-container::-webkit-scrollbar {
      width: 0;
      height: 0;
      display: none;
    }
  `}</style>

      <div
        className={`absolute left-0 bottom-0 z-10 transition-[top,right] duration-300 ease ${readerTopOffsetClass} ${readerContentRightOffsetClass}`}
      >
        {renderReaderContent()}
      </div>

      <div
        className="fixed inset-x-0 top-0 z-[70] h-[0.1rem]"
        style={{ backgroundColor: palette.page }}
      >
        <div
          className="h-full bg-[var(--accent)]"
          style={{ width: `${clamp(progress, 0, 1) * 100}%` }}
        />
      </div>

      <div className="pointer-events-none relative z-30">
        <div
          className={`group/reader-nav pointer-events-auto fixed inset-x-0 top-0 z-[60] overflow-visible pt-[calc(0.35rem+var(--safe-area-inset-top))] transition-[height] duration-200 ease ${readerNavHeightClass} ${palette.pageBorder}`}
          style={{ backgroundColor: palette.page, color: palette.text }}
        >
          <header className="relative grid h-10 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)_minmax(0,1fr)] sm:px-3">
            <div
              className={`flex min-w-0 items-center gap-2 ${topControlVisibility}`}
            >
              <BackButton
                fallbackTo={ownerRoute}
                className="shrink-0 p-[0.05rem]"
                style={controlSurfaceStyle}
                buttonStyle={controlTextStyle}
                label=""
                noYShift
              />
              {tocItems.length > 0 ? (
                <ReaderIconButton
                  label={t("reader.chapters")}
                  className={`${glassIconButton} sm:hidden`}
                  style={
                    tocOpen ? activeControlSurfaceStyle : controlSurfaceStyle
                  }
                  onClick={() => setTocOpen((isOpen) => !isOpen)}
                >
                  <ListTree size={18} />
                </ReaderIconButton>
              ) : null}
              <Link
                to={ownerRoute}
                className={`${topControlClass} hidden shrink-0 sm:inline-flex`}
                style={controlSurfaceStyle}
              >
                {t("common.details")}
              </Link>
            </div>

            <h1
              className={`pointer-events-none absolute left-1/2 w-full max-w-24 -translate-x-1/2 truncate px-1 text-center text-sm font-black transition-[opacity,transform] duration-250 ease sm:static sm:max-w-none sm:translate-x-0 sm:px-3 sm:text-base ${
                isReaderContentReady
                  ? "translate-y-0 opacity-70 sm:group-hover/reader-nav:opacity-100"
                  : "translate-y-1 opacity-0"
              }`}
              style={{ color: palette.text }}
            >
              {title}
            </h1>

            <div
              className={`ml-auto flex min-w-0 items-center justify-end ${topControlVisibility}`}
            >
              <SegmentedIconToolbar
                actions={readerToolbarActions}
                ariaLabel={t("reader.settings")}
                size="md"
                style={controlSurfaceStyle}
                itemStyle={controlTextStyle}
                activeItemStyle={activeToolbarItemStyle}
                inactiveItemStyle={controlTextStyle}
              />
            </div>
          </header>
          {renderSettingsPanel()}
        </div>

        {renderTocPanel()}
      </div>

      <div
        className={`${glassPillButton} pointer-events-none fixed bottom-[calc(0.85rem+var(--safe-area-inset-bottom))] left-1/2 z-30 min-w-10 -translate-x-1/2 px-3 tabular-nums backdrop-blur-sm backdrop-saturate-150 ${
          settings.theme === "night" ? "bg-black/20" : "bg-white/20"
        }`}
      >
        {readerPageNumber}
      </div>
    </main>
  );
}
