import type { CSSProperties } from "react";
import type { NavItem } from "epubjs";
import { glassPillButton } from "../../components/ui/glassControlStyles";
import type { JellyfinItem } from "../../lib/types";

export type ReaderFormat =
  | "epub"
  | "pdf"
  | "text"
  | "html"
  | "image"
  | "fallback";
export type ReaderTheme = "night" | "sepia";

export interface ReaderSettings {
  theme: ReaderTheme;
  fontScale: number;
  lineHeight: number;
  width: number;
}

export interface StoredReaderProgress {
  cfi?: string;
  scrollRatio?: number;
  updatedAt: number;
}

export type ReaderProgressMap = Record<string, StoredReaderProgress>;

export interface EpubContentView {
  document: Document;
  addClass(className: string): void;
  addStylesheetCss(css: string, key: string): unknown;
}

export const READER_SETTINGS_KEY = "seyirlik.reader.settings";
export const READER_PROGRESS_KEY = "seyirlik.reader.progress";

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  theme: "night",
  fontScale: 100,
  lineHeight: 1.7,
  width: 74,
};

export const FONT_SCALE_STEPS = Array.from(
  { length: 14 },
  (_, index) => 80 + index * 5,
);
export const LINE_HEIGHT_STEPS = Array.from({ length: 14 }, (_, index) =>
  Number((1.25 + ((2.2 - 1.25) * index) / 13).toFixed(2)),
);
export const WIDTH_STEPS = Array.from(
  { length: 13 },
  (_, index) => 48 + index * 4,
);

export const EPUB_PREPARATION_TIMEOUT_MS = 15000;

export const EPUB_REVEAL_STYLES = `
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

.seyirlik-reader-block {
  opacity: 0;
  animation: seyirlikReaderBlockFadeIn 520ms ease forwards;
  will-change: opacity, transform;
}

@media (prefers-reduced-motion: reduce) {
  .seyirlik-reader-block {
    opacity: 1;
    transform: none;
    animation: none;
  }
}
`;

export const EPUB_CONTENT_DIVIDER_STYLES = `
hr {
  border: 0 !important;
  height: 1px !important;
  width: 70% !important;
  margin: 3em auto 2.2em auto !important;
  background: linear-gradient(
    to right,
    transparent,
    currentColor,
    transparent
  ) !important;
  opacity: 0.22 !important;
}

h1::before,
h2::before {
  content: "";
  display: block !important;
  width: 70% !important;
  height: 1px !important;
  margin: 0 auto 2.4em auto !important;
  background: linear-gradient(
    to right,
    transparent,
    currentColor,
    transparent
  ) !important;
  opacity: 0.22 !important;
}

.firstHeading::before {
  display: none !important;
}

h1 + h1::before,
h1 + h2::before,
h2 + h1::before,
h2 + h2::before {
  display: none !important;
}
`;

export const READER_THEME_LABEL_KEYS = {
  night: "reader.theme.night",
  sepia: "reader.theme.sepia",
} as const;

export const FORMAT_EXTENSIONS: Record<
  Exclude<ReaderFormat, "fallback">,
  string[]
> = {
  epub: ["epub"],
  pdf: ["pdf"],
  text: ["txt", "md", "markdown", "log", "srt", "vtt"],
  html: ["html", "htm", "xhtml"],
  image: ["jpg", "jpeg", "png", "webp", "gif", "avif"],
};

export const themePalettes: Record<
  ReaderTheme,
  {
    shell: string;
    panel: string;
    page: string;
    pageBorder: string;
    text: string;
    muted: string;
    control: string;
    activeControl: string;
    controlBackground: string;
    controlActiveBackground: string;
    controlText: string;
    controlMutedText: string;
    controlShadow: string;
    controlFlatShadow: string;
    accent: string;
  }
> = {
  night: {
    shell: "bg-[#111114] text-[#f4f4f5]",
    panel: "border-white/10 bg-[#111114] text-[#f4f4f5] shadow-floating-panel",
    page: "#111114",
    pageBorder: "border-white/10",
    text: "#f4f4f5",
    muted: "text-white/58",
    control: glassPillButton,
    activeControl: `${glassPillButton} bg-white/[0.11] text-white`,
    controlBackground: "rgba(23, 23, 25, 0.76)",
    controlActiveBackground: "rgba(255, 255, 255, 0.14)",
    controlText: "#f4f4f5",
    controlMutedText: "rgba(244, 244, 245, 0.58)",
    controlShadow:
      "0 0 0 1px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(0,0,0,0.3), 0 10px 35px rgba(0,0,0,0.28)",
    controlFlatShadow:
      "0 0 0 1px rgba(255,255,255,0.07), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 -1px 0 rgba(0,0,0,0.3)",
    accent: "#8bd8be",
  },
  sepia: {
    shell: "bg-[#f4ead7] text-[#241b12]",
    panel:
      "border-[#2d2216]/12 bg-[#f4ead7] text-[#241b12] shadow-[0_24px_80px_rgba(45,34,22,0.13)]",
    page: "#f4ead7",
    pageBorder: "border-[#2d2216]/12",
    text: "#241b12",
    muted: "text-[#6f5f4c]",
    control: glassPillButton,
    activeControl: `${glassPillButton} bg-white/[0.11] text-white`,
    controlBackground: "rgba(244, 234, 215, 0.84)",
    controlActiveBackground: "rgba(45, 34, 22, 0.11)",
    controlText: "#241b12",
    controlMutedText: "rgba(36, 27, 18, 0.62)",
    controlShadow:
      "0 0 0 1px rgba(45,34,22,0.13), inset 0 1px 0 rgba(255,255,255,0.48), inset 0 -1px 0 rgba(45,34,22,0.06), 0 14px 38px rgba(45,34,22,0.12)",
    controlFlatShadow:
      "0 0 0 1px rgba(45,34,22,0.13), inset 0 1px 0 rgba(255,255,255,0.48), inset 0 -1px 0 rgba(45,34,22,0.06)",
    accent: "#2d6a50",
  },
};

export type ReaderPalette = (typeof themePalettes)[ReaderTheme];

export function getReaderControlStyle(
  palette: ReaderPalette,
  active = false,
  flat = false,
): CSSProperties {
  return {
    backgroundColor: active
      ? palette.controlActiveBackground
      : palette.controlBackground,
    color: palette.controlText,
    boxShadow: flat ? palette.controlFlatShadow : palette.controlShadow,
  };
}

export function getThemePreviewControlStyle(
  palette: ReaderPalette,
  active: boolean,
  flat = false,
): CSSProperties {
  const shadow = flat ? palette.controlFlatShadow : palette.controlShadow;

  return {
    ...getReaderControlStyle(palette, false, flat),
    boxShadow: active ? `0 0 0 1.5px ${palette.accent}, ${shadow}` : shadow,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function isReaderTheme(value: unknown): value is ReaderTheme {
  return value === "night" || value === "sepia";
}

export function readJsonStorage<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonStorage(key: string, value: unknown): void {
  localStorage.setItem(key, JSON.stringify(value));
}

export function readStoredReaderSettings(): ReaderSettings {
  const stored = readJsonStorage<Partial<ReaderSettings>>(
    READER_SETTINGS_KEY,
    {},
  );

  return {
    theme: isReaderTheme(stored.theme)
      ? stored.theme
      : DEFAULT_READER_SETTINGS.theme,
    fontScale:
      typeof stored.fontScale === "number"
        ? clamp(stored.fontScale, 80, 145)
        : DEFAULT_READER_SETTINGS.fontScale,
    lineHeight:
      typeof stored.lineHeight === "number"
        ? clamp(stored.lineHeight, 1.25, 2.2)
        : DEFAULT_READER_SETTINGS.lineHeight,
    width:
      typeof stored.width === "number"
        ? clamp(stored.width, 48, 96)
        : DEFAULT_READER_SETTINGS.width,
  };
}

export function readReaderProgress(
  itemId: string,
): StoredReaderProgress | null {
  const progress = readJsonStorage<ReaderProgressMap>(READER_PROGRESS_KEY, {});
  return progress[itemId] ?? null;
}

export function writeReaderProgress(
  itemId: string,
  nextProgress: Omit<StoredReaderProgress, "updatedAt">,
): void {
  const progress = readJsonStorage<ReaderProgressMap>(READER_PROGRESS_KEY, {});
  progress[itemId] = {
    ...progress[itemId],
    ...nextProgress,
    updatedAt: Date.now(),
  };
  writeJsonStorage(READER_PROGRESS_KEY, progress);
}

export function getNormalizedExtension(value?: string): string | null {
  if (!value) {
    return null;
  }

  const cleanedValue = value.split(/[?#]/)[0]?.trim().toLowerCase() ?? "";
  const finalSegment = cleanedValue.split(/[\\/]/).pop() ?? cleanedValue;
  const extension = finalSegment.includes(".")
    ? finalSegment.slice(finalSegment.lastIndexOf(".") + 1)
    : finalSegment;
  const normalizedExtension = extension.replace(/[^a-z0-9]/g, "");

  return normalizedExtension || null;
}

export function getReaderFormat(item: JellyfinItem): ReaderFormat {
  const candidates = [
    item.MediaSources?.find((source) => source.Container)?.Container,
    item.MediaSources?.find((source) => source.Path)?.Path,
    item.Path,
    item.Name,
  ]
    .map(getNormalizedExtension)
    .filter((extension): extension is string => Boolean(extension));

  for (const extension of candidates) {
    for (const [format, extensions] of Object.entries(FORMAT_EXTENSIONS)) {
      if (extensions.includes(extension)) {
        return format as ReaderFormat;
      }
    }
  }

  return "fallback";
}

export function getFormatLabel(format: ReaderFormat): string {
  if (format === "fallback") {
    return "FILE";
  }

  return format.toUpperCase();
}

export function flattenToc(
  items: NavItem[],
  depth = 0,
): Array<NavItem & { depth: number }> {
  return items.flatMap((item) => [
    { ...item, depth },
    ...(item.subitems ? flattenToc(item.subitems, depth + 1) : []),
  ]);
}
