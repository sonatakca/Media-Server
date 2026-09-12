import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useLanguage } from "../../../i18n/LanguageContext";
import type { TranslationKey } from "../../../i18n/translations";
import type { MediaItem } from "../../../lib/types";
import { formatTemplate, getDisplayTitle } from "../../../lib/format";
import { TitlePoster } from "../../../components/admin/TitlePoster";
import { Tooltip } from "../../../components/ui/Tooltip";
import {
  TITLE_KIND_FILTERS,
  filterByKind,
  filterTitles,
  getStatusClasses,
  titleArtworkOf,
  type ActionStatus,
  type TitleKindFilter,
} from "../tmdbArtworkModel";

const KIND_LABEL: Record<TitleKindFilter, TranslationKey> = {
  all: "tmdbArtwork.kindFilter.all",
  Movie: "library.movies",
  Series: "library.shows",
  Book: "library.books",
};

/**
 * The titles to work through, kept in view.
 *
 * Sticky beside the editor: the page scrolls through a title's posters,
 * backdrops and logos while this list stays where it is, and it scrolls on its
 * own only when the pointer is over it. Each thumbnail is drawn as its card is
 * — cover, logo where it was placed, shadow as it was set — so the list shows
 * what the editor changed as soon as it is saved.
 */
export function ArtworkTitleList({
  titles,
  status,
  selectedId,
  onSelect,
}: {
  titles: readonly MediaItem[];
  status: ActionStatus;
  selectedId: string | null;
  onSelect: (item: MediaItem) => void;
}) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<TitleKindFilter>("all");
  const visible = useMemo(
    () => filterTitles(filterByKind(titles, kind), search),
    [titles, kind, search],
  );

  return (
    <aside className="xl:sticky xl:top-24 xl:self-start">
      <section
        aria-label={t("tmdbArtwork.libraryTitles")}
        className="flex flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-4 xl:max-h-[calc(100dvh-8rem)]"
      >
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-black uppercase tracking-[0.14em] text-white/70">
            {t("tmdbArtwork.libraryTitles")}
          </h2>
          <span className="text-xs font-bold tabular-nums text-white/35">
            {formatTemplate(t("tmdbArtwork.visibleItems"), {
              count: visible.length,
            })}
          </span>
        </div>
        {status.tone !== "success" ? (
          <p
            className={`mt-1 text-xs font-bold ${getStatusClasses(status.tone)}`}
          >
            {status.message}
          </p>
        ) : null}

        <label className="mt-3 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/40 px-3 py-2">
          <Search
            className="h-4 w-4 shrink-0 text-white/35"
            aria-hidden="true"
          />
          <span className="sr-only">
            {t("tmdbArtwork.itemSearchPlaceholder")}
          </span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("tmdbArtwork.itemSearchPlaceholder")}
            className="w-full bg-transparent text-sm font-semibold outline-none placeholder:text-white/25"
          />
          {search ? (
            <Tooltip content={t("tmdbArtwork.clearSearch")}>
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label={t("tmdbArtwork.clearSearch")}
                className="rounded-md p-0.5 text-white/40 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}
        </label>

        <div
          role="group"
          aria-label={t("tmdbArtwork.kindFilter.label")}
          className="mt-2 flex flex-wrap gap-1"
        >
          {TITLE_KIND_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
              className={`rounded-full px-2.5 py-1 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                kind === value
                  ? "bg-white/15 text-white"
                  : "text-white/50 hover:text-white"
              }`}
            >
              {t(KIND_LABEL[value])}
            </button>
          ))}
        </div>

        {/* Its own scroll, contained: reaching the end does not scroll the page. */}
        <ul className="-mx-1 mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-1 max-xl:max-h-[50vh]">
          {visible.map((item) => {
            const selected = item.Id === selectedId;
            return (
              <li key={item.Id}>
                <button
                  type="button"
                  onClick={() => onSelect(item)}
                  aria-current={selected ? "true" : undefined}
                  className={`flex w-full items-center gap-3 rounded-2xl px-2 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${
                    selected
                      ? "bg-[var(--accent)]/15 ring-1 ring-[var(--accent)]/50"
                      : "hover:bg-white/[0.06]"
                  }`}
                >
                  <TitlePoster
                    itemId={item.Id}
                    title={getDisplayTitle(item)}
                    artwork={titleArtworkOf(item)}
                    width={44}
                    className="rounded-lg"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-white/90">
                      {getDisplayTitle(item)}
                    </span>
                    <span className="block text-xs font-semibold text-white/35">
                      {t(KIND_LABEL[(item.Type as TitleKindFilter) ?? "all"])}
                      {item.ProductionYear ? ` · ${item.ProductionYear}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
