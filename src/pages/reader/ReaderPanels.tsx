import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Download, ExternalLink, Trash2, X } from "lucide-react";
import type { NavItem } from "epubjs";
import { TitlePoster } from "../../components/admin/TitlePoster";
import { useLanguage } from "../../i18n/LanguageContext";
import { getLogoLayout } from "../../lib/logoLayout";
import type { MediaItem } from "../../lib/types";
import { BOOK_SANS, BOOK_SERIF } from "./epubTypography";
import { formatDuration, formatPercent, splitNumber } from "./readerText";
import {
  FONT_SCALE_STEPS,
  LINE_HEIGHT_PRESETS,
  READER_SPOTLIGHTS,
  READER_THEMES,
  READER_THEME_LABEL_KEYS,
  WIDTH_PRESETS,
  minutesForLocations,
  nearest,
  themePalettes,
  type ReaderBookmark,
  type ReaderSettings,
} from "./readerModel";
import type { BookChapter, BookMap } from "./readingLight";

function SegmentButtons<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="rd-seg">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === value}
          aria-label={option.icon ? option.label : undefined}
          title={option.icon ? option.label : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  );
}

function LinesIcon({ gaps }: { gaps: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d={`M5 ${12 - gaps}h14M5 12h14M5 ${12 + gaps}h14`} />
    </svg>
  );
}

function MeasureIcon({ half }: { half: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d={`M${12 - half} 7h${half * 2}M${12 - half} 12h${half * 2}M${12 - half} 17h${half * 2}`} />
    </svg>
  );
}

export const ReaderSettingsPanel = forwardRef<
  HTMLElement,
  {
    open: boolean;
    settings: ReaderSettings;
    showReadingLight: boolean;
    onChange: (patch: Partial<ReaderSettings>) => void;
  }
>(function ReaderSettingsPanel(
  { open, settings, showReadingLight, onChange },
  ref,
) {
  const { t } = useLanguage();
  const sizeIndex = FONT_SCALE_STEPS.indexOf(
    nearest(FONT_SCALE_STEPS, settings.fontScale),
  );
  const sizePercent = (sizeIndex / (FONT_SCALE_STEPS.length - 1)) * 100;

  return (
    <section
      ref={ref}
      role="dialog"
      aria-label={t("reader.appearance")}
      aria-hidden={!open}
      data-open={open || undefined}
      className="rd-surface rd-popover rd-settings"
    >
      <div className="rd-grab" aria-hidden="true" />
      <div className="rd-row">
        <p className="rd-label">{t("reader.theme")}</p>
        <div className="rd-themes" role="group" aria-label={t("reader.theme")}>
          {READER_THEMES.map((theme) => {
            const palette = themePalettes[theme];

            return (
              <button
                key={theme}
                type="button"
                className="rd-theme"
                aria-pressed={settings.theme === theme}
                onClick={() => onChange({ theme })}
              >
                <span
                  className="rd-theme-swatch"
                  style={{ background: palette.ground, color: palette.ink }}
                  aria-hidden="true"
                >
                  Aa
                </span>
                <span className="rd-theme-name">
                  {t(READER_THEME_LABEL_KEYS[theme])}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rd-row">
        <p className="rd-label">{t("reader.typeface")}</p>
        <div className="rd-faces" role="group" aria-label={t("reader.typeface")}>
          {(
            [
              ["serif", "Literata", t("reader.face.serifNote"), BOOK_SERIF, 450],
              ["sans", "Archivo", t("reader.face.sansNote"), BOOK_SANS, 650],
            ] as const
          ).map(([face, name, note, family, weight]) => (
            <button
              key={face}
              type="button"
              className="rd-face"
              aria-pressed={settings.face === face}
              onClick={() => onChange({ face })}
            >
              <span
                className="rd-face-sample"
                style={{ fontFamily: family, fontWeight: weight }}
                aria-hidden="true"
              >
                Ağ
              </span>
              <span className="rd-face-name">{name}</span>
              <span className="rd-face-note">{note}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rd-row">
        <label className="rd-label" htmlFor="rd-font-size">
          {t("reader.fontSize")}
          <output htmlFor="rd-font-size">{`${settings.fontScale}%`}</output>
        </label>
        <div className="rd-size">
          <span aria-hidden="true">A</span>
          <input
            id="rd-font-size"
            className="rd-range"
            type="range"
            min={0}
            max={FONT_SCALE_STEPS.length - 1}
            step={1}
            value={sizeIndex}
            aria-valuetext={`${settings.fontScale}%`}
            style={{ "--pct": `${sizePercent}%` } as CSSProperties}
            onChange={(event) =>
              onChange({
                fontScale: FONT_SCALE_STEPS[Number(event.currentTarget.value)],
              })
            }
          />
          <span aria-hidden="true">A</span>
        </div>
      </div>

      <div className="rd-row rd-pair">
        <div>
          <p className="rd-label">{t("reader.lineHeight")}</p>
          <SegmentButtons
            label={t("reader.lineHeight")}
            value={nearest(LINE_HEIGHT_PRESETS, settings.lineHeight)}
            onChange={(lineHeight) => onChange({ lineHeight })}
            options={[
              { value: LINE_HEIGHT_PRESETS[0], label: t("reader.spacing.tight"), icon: <LinesIcon gaps={4} /> },
              { value: LINE_HEIGHT_PRESETS[1], label: t("reader.spacing.normal"), icon: <LinesIcon gaps={5.5} /> },
              { value: LINE_HEIGHT_PRESETS[2], label: t("reader.spacing.loose"), icon: <LinesIcon gaps={7.5} /> },
            ]}
          />
        </div>
        <div>
          <p className="rd-label">{t("reader.column")}</p>
          <SegmentButtons
            label={t("reader.column")}
            value={nearest(WIDTH_PRESETS, settings.width)}
            onChange={(width) => onChange({ width })}
            options={[
              { value: WIDTH_PRESETS[0], label: t("reader.width.narrow"), icon: <MeasureIcon half={3} /> },
              { value: WIDTH_PRESETS[1], label: t("reader.width.medium"), icon: <MeasureIcon half={5} /> },
              { value: WIDTH_PRESETS[2], label: t("reader.width.wide"), icon: <MeasureIcon half={8} /> },
            ]}
          />
        </div>
      </div>

      {showReadingLight ? (
        <div className="rd-row">
          <p className="rd-label">{t("reader.readingLight")}</p>
          <SegmentButtons
            label={t("reader.readingLight")}
            value={settings.spotlight}
            onChange={(spotlight) => onChange({ spotlight })}
            options={READER_SPOTLIGHTS.map((spotlight) => ({
              value: spotlight,
              label: t(`reader.light.${spotlight}`),
            }))}
          />
        </div>
      ) : null}
    </section>
  );
});

export const ReaderMoreMenu = forwardRef<
  HTMLDivElement,
  {
    open: boolean;
    fileUrl: string;
    downloadUrl: string;
    sizeLabel: string | null;
    finishedControl: ReactNode;
    onClose: () => void;
  }
>(function ReaderMoreMenu(
  { open, fileUrl, downloadUrl, sizeLabel, finishedControl, onClose },
  ref,
) {
  const { t } = useLanguage();

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t("reader.more")}
      aria-hidden={!open}
      data-open={open || undefined}
      className="rd-surface rd-popover rd-menu"
    >
      {finishedControl}
      <a
        role="menuitem"
        className="rd-menu-item"
        href={fileUrl}
        target="_blank"
        rel="noreferrer"
        onClick={onClose}
      >
        <ExternalLink size={18} aria-hidden="true" />
        {t("reader.openOriginal")}
      </a>
      <a
        role="menuitem"
        className="rd-menu-item"
        href={downloadUrl}
        download
        onClick={onClose}
      >
        <Download size={18} aria-hidden="true" />
        {t("reader.downloadBook")}
        {sizeLabel ? <small>{sizeLabel}</small> : null}
      </a>
    </div>
  );
});

type TocEntry = NavItem & { depth: number };

interface ContentsRow {
  entry: TocEntry;
  start: number | null;
  end: number | null;
}

function buildRows(
  toc: TocEntry[],
  map: BookMap | null,
  spineIndexOf: (href: string) => number | null,
): ContentsRow[] {
  if (!map) {
    return toc.map((entry) => ({ entry, start: null, end: null }));
  }

  const starts = toc.map((entry) => {
    const index = spineIndexOf(entry.href);
    return index === null ? null : (map.sectionStarts[index] ?? null);
  });

  return toc.map((entry, index) => {
    const start = starts[index];

    if (start === null) {
      return { entry, start: null, end: null };
    }

    let end = map.total;

    for (let next = index + 1; next < toc.length; next += 1) {
      const nextStart = starts[next];

      if (nextStart !== null && nextStart > start) {
        end = nextStart;
        break;
      }
    }

    return { entry, start, end };
  });
}

export function ReaderContentsDrawer({
  open,
  tab,
  onTab,
  title,
  author,
  item,
  toc,
  map,
  location,
  currentHref,
  bookmarks,
  spineIndexOf,
  onNavigate,
  onRemoveBookmark,
  onClose,
}: {
  open: boolean;
  tab: "contents" | "bookmarks";
  onTab: (tab: "contents" | "bookmarks") => void;
  title: string;
  author: string;
  item: MediaItem;
  toc: TocEntry[];
  map: BookMap | null;
  location: number | null;
  currentHref: string | null;
  bookmarks: ReaderBookmark[];
  spineIndexOf: (href: string) => number | null;
  onNavigate: (target: string) => void;
  onRemoveBookmark: (id: string) => void;
  onClose: () => void;
}) {
  const { t, language } = useLanguage();
  const drawerRef = useRef<HTMLElement | null>(null);
  const rows = useMemo(
    () => buildRows(toc, map, spineIndexOf),
    [map, spineIndexOf, toc],
  );
  const longest = Math.max(
    1,
    ...rows.map((row) =>
      row.start !== null && row.end !== null ? row.end - row.start : 0,
    ),
  );
  const currentIndex = useMemo(() => {
    if (location !== null) {
      let found = -1;
      rows.forEach((row, index) => {
        if (row.start !== null && row.start <= location) {
          found = index;
        }
      });
      return found;
    }

    // Before the book is measured: the last chapter starting at or before the
    // section on screen.
    const here = currentHref ? spineIndexOf(currentHref) : null;
    if (here === null) {
      return -1;
    }
    let found = -1;
    rows.forEach((row, index) => {
      const spine = spineIndexOf(row.entry.href);
      if (spine !== null && spine <= here) {
        found = index;
      }
    });
    return found;
  }, [currentHref, location, rows, spineIndexOf]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const drawer = drawerRef.current;
    const focusTarget =
      drawer?.querySelector<HTMLElement>('[aria-current="true"]') ??
      drawer?.querySelector<HTMLElement>("button");
    focusTarget?.focus({ preventScroll: true });
    focusTarget?.scrollIntoView({ block: "center" });
  }, [open, tab]);

  const progress = map && location !== null ? location / map.total : null;

  return (
    <>
      <div
        className="rd-scrim"
        data-open={open || undefined}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("reader.contents")}
        aria-hidden={!open}
        data-open={open || undefined}
        className="rd-surface rd-drawer"
      >
        <div className="rd-drawer-head">
          {item.ImageTags?.Primary ? (
            <ReaderBookCover item={item} width={72} className="rd-drawer-cover" />
          ) : (
            <span />
          )}
          <div>
            <h2 className="rd-drawer-title">{title}</h2>
            {author ? <div className="rd-drawer-author">{author}</div> : null}
            {progress !== null && map ? (
              <div className="rd-drawer-progress">
                <span>
                  {t("reader.percentRead").replace(
                    "{percent}",
                    formatPercent(progress, language),
                  )}
                </span>
                <span>
                  {t("reader.timeLeftInBook").replace(
                    "{time}",
                    formatDuration(
                      minutesForLocations(map.total - (location ?? 0)),
                      t,
                    ),
                  )}
                </span>
              </div>
            ) : (
              <div className="rd-drawer-progress" data-pending>
                <span>{t("reader.measuring")}</span>
              </div>
            )}
          </div>
          <button
            type="button"
            className="rd-icon-button rd-drawer-close"
            aria-label={t("reader.closeContents")}
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="rd-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "contents"}
            onClick={() => onTab("contents")}
          >
            {t("reader.contents")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bookmarks"}
            onClick={() => onTab("bookmarks")}
          >
            {t("reader.bookmarks")}
            {bookmarks.length > 0 ? (
              <span className="rd-count">{bookmarks.length}</span>
            ) : null}
          </button>
        </div>

        {tab === "contents" ? (
          rows.length > 0 ? (
            <ol className="rd-list" role="tabpanel">
              {rows.map((row, index) => {
                const { number, title: rowTitle } = splitNumber(row.entry.label);
                const length =
                  row.start !== null && row.end !== null ? row.end - row.start : null;
                const read =
                  length !== null && location !== null && row.start !== null
                    ? Math.min(1, Math.max(0, (location - row.start) / Math.max(1, length)))
                    : 0;
                const isCurrent = index === currentIndex;

                return (
                  <li key={`${row.entry.href}-${index}`}>
                    <button
                      type="button"
                      className="rd-chapter"
                      data-depth={Math.min(row.entry.depth, 2)}
                      aria-current={isCurrent || undefined}
                      style={{ paddingLeft: `${0.75 + Math.min(row.entry.depth, 2) * 0.75}rem` }}
                      onClick={() => onNavigate(row.entry.href)}
                    >
                      <span className="rd-chapter-n" aria-hidden="true">
                        {number || "·"}
                      </span>
                      <span className="rd-chapter-t">
                        {number ? <span className="sr-only">{number} </span> : null}
                        {rowTitle}
                        {isCurrent ? (
                          <span className="rd-chapter-here">{t("reader.youAreHere")}</span>
                        ) : null}
                      </span>
                      <span className="rd-chapter-time">
                        {length !== null && length > 0 ? (
                          formatDuration(minutesForLocations(length), t)
                        ) : map ? (
                          ""
                        ) : (
                          <span className="rd-pending-bit" aria-hidden="true" />
                        )}
                      </span>
                      {length !== null && length > 0 ? (
                        <span className="rd-chapter-len" aria-hidden="true">
                          <span style={{ width: `${Math.max(3, (length / longest) * 100)}%` }} />
                          <span style={{ width: `${Math.max(3, (length / longest) * 100) * read}%` }} />
                        </span>
                      ) : map ? null : (
                        <span className="rd-chapter-len" data-pending aria-hidden="true" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="rd-empty">{t("reader.noChapters")}</p>
          )
        ) : bookmarks.length > 0 ? (
          <ul className="rd-list" role="tabpanel">
            {bookmarks.map((bookmark) => (
              <li key={bookmark.id} className="rd-bookmark">
                <button
                  type="button"
                  className="rd-bookmark-go"
                  onClick={() => onNavigate(bookmark.cfi)}
                >
                  {bookmark.excerpt ? (
                    <span className="rd-bookmark-excerpt">{bookmark.excerpt}</span>
                  ) : null}
                  <span className="rd-bookmark-label">
                    <span>{bookmark.label}</span>
                    {bookmark.progress !== null ? (
                      <b>{formatPercent(bookmark.progress, language)}</b>
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className="rd-icon-button"
                  aria-label={t("reader.removeBookmark")}
                  onClick={() => onRemoveBookmark(bookmark.id)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rd-empty" role="tabpanel">
            {t("reader.noBookmarks")}
          </p>
        )}
      </aside>
    </>
  );
}

/**
 * The book as the library draws it — cover, and the logo in the place, at the
 * width and with the shadow it was adjusted to — bound like a book: a spine
 * fold down the left edge and a lift under it. `width` is in pixels; the
 * logo's shadow is scaled to it, as on every other poster.
 */
export function ReaderBookCover({
  item,
  width,
  className = "",
}: {
  item: MediaItem;
  width: number;
  className?: string;
}) {
  const coverTag = item.ImageTags?.Primary ?? null;

  if (!coverTag) {
    return null;
  }

  return (
    <TitlePoster
      itemId={item.Id}
      title={item.Name ?? ""}
      artwork={{
        coverTag,
        logoTag: item.ImageTags?.Logo ?? null,
        logoLayout: getLogoLayout(item),
      }}
      width={width}
      className={`rd-book ${className}`}
    />
  );
}

/** The chapter as a ruler in the left margin; the marker is moved by the page directly. */
export const ChapterRuler = forwardRef<
  HTMLDivElement,
  {
    left: number;
    chapter: BookChapter;
    next: BookChapter | null;
    chapterNumber: string;
  }
>(function ChapterRuler({ left, chapter, next, chapterNumber }, markerRef) {
  const ticks = useMemo(() => {
    const length = Math.max(1, chapter.end - chapter.start);
    // About one tick per two locations (roughly a printed page), but always a
    // graduated scale: a short chapter still reads as a ruler, not a few notches.
    const count = Math.min(80, Math.max(40, Math.round(length / 2)));

    return Array.from({ length: count + 1 }, (_, index) => ({
      at: index / count,
      major: index % 10 === 0,
    }));
  }, [chapter.end, chapter.start]);

  return (
    <div className="rd-ruler" style={{ left }} aria-hidden="true">
      <div className="rd-ruler-line" />
      {ticks.map((tick) => (
        <span
          key={tick.at}
          className="rd-ruler-tick"
          data-major={tick.major || undefined}
          style={{ top: `${tick.at * 100}%` }}
        />
      ))}
      <span className="rd-ruler-cap" data-edge="top">
        {chapterNumber ? `${chapterNumber} · ` : ""}
        {splitNumber(chapter.label).title}
      </span>
      {next ? (
        <span className="rd-ruler-cap" data-edge="bottom">
          {splitNumber(next.label).title}
        </span>
      ) : null}
      <div ref={markerRef} className="rd-ruler-marker">
        <span />
      </div>
    </div>
  );
});

