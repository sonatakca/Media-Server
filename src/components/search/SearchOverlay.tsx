import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../i18n/LanguageContext";
import { formatTemplate } from "../../lib/format";
import { getPrimaryImageUrl, searchItems } from "../../lib/mediaApi";
import { getRouteForItem } from "../../lib/routes";
import {
  SEARCH_DEBOUNCE_MS,
  flattenSearchGroups,
  groupSearchResults,
  isSearchableQuery,
  type SearchGroup,
} from "../../lib/searchModel";
import type { MediaItem } from "../../lib/types";

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

type SearchStatus = "idle" | "loading" | "ready" | "failed";

function getResultSubtitle(item: MediaItem): string {
  if (item.Type === "Episode") {
    const seasonNumber = item.ParentIndexNumber;
    const episodeNumber = item.IndexNumber;
    const numbering =
      typeof seasonNumber === "number" && typeof episodeNumber === "number"
        ? `S${seasonNumber}·E${episodeNumber}`
        : null;

    return [item.SeriesName, numbering].filter(Boolean).join(" · ");
  }

  return item.ProductionYear ? String(item.ProductionYear) : "";
}

function ResultThumbnail({ item }: { item: MediaItem }) {
  const imageUrl = item.ImageTags?.Primary
    ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 160)
    : "";

  return (
    <span className="relative block h-14 w-10 shrink-0 overflow-hidden rounded-md bg-white/[0.06]">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : null}
    </span>
  );
}

export function SearchOverlay({ isOpen, onClose }: SearchOverlayProps) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Guards against a slow request for an old query overwriting a newer one.
  const requestSequenceRef = useRef(0);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [results, setResults] = useState<MediaItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const groups: SearchGroup[] = useMemo(
    () => groupSearchResults(results),
    [results],
  );
  const flatResults = useMemo(() => flattenSearchGroups(groups), [groups]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setQuery("");
    setResults([]);
    setStatus("idle");
    setActiveIndex(0);

    // The input mounts with the overlay, so focus has to wait for paint.
    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(focusFrame);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    return () => {
      body.style.overflow = previousOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    if (!isSearchableQuery(query)) {
      requestSequenceRef.current += 1;
      setResults([]);
      setStatus("idle");
      return;
    }

    const sequence = ++requestSequenceRef.current;
    setStatus("loading");

    const timeoutId = window.setTimeout(() => {
      void searchItems(query.trim())
        .then((items) => {
          if (sequence !== requestSequenceRef.current) {
            return;
          }

          setResults(items);
          setActiveIndex(0);
          setStatus("ready");
        })
        .catch((error: unknown) => {
          if (sequence !== requestSequenceRef.current) {
            return;
          }

          console.warn("[Seyirlik Search] Search failed", error);
          setResults([]);
          setStatus("failed");
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [isOpen, query]);

  const openResult = useCallback(
    (item: MediaItem) => {
      onClose();
      navigate(getRouteForItem(item));
    },
    [navigate, onClose],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (flatResults.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % flatResults.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (current) => (current - 1 + flatResults.length) % flatResults.length,
      );
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const item = flatResults[activeIndex];

      if (item) {
        openResult(item);
      }
    }
  };

  useEffect(() => {
    const activeElement = listRef.current?.querySelector<HTMLElement>(
      '[data-search-active="true"]',
    );

    // Guarded because scrollIntoView is absent in non-browser DOMs.
    if (typeof activeElement?.scrollIntoView === "function") {
      activeElement.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  const hasQuery = isSearchableQuery(query);
  let flatIndex = -1;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("search.title")}
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-[200] flex justify-center bg-black/72 p-4 pt-[max(env(safe-area-inset-top),4rem)] backdrop-blur-md"
    >
      {/*
        A sibling backdrop button rather than a click handler on the dialog, so
        clicking away is reachable by pointer without swallowing keyboard focus
        or making the dialog itself a control.
      */}
      <button
        type="button"
        aria-label={t("search.close")}
        onClick={onClose}
        className="absolute inset-0 z-0 cursor-default"
      />

      <div className="relative z-10 flex h-fit max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[rgba(18,18,20,0.97)] shadow-[0_32px_120px_rgba(0,0,0,0.75)]">
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Search size={18} className="shrink-0 text-white/45" />

          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("search.placeholder")}
            aria-label={t("search.placeholder")}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-base font-semibold text-white outline-none placeholder:font-medium placeholder:text-white/35 [&::-webkit-search-cancel-button]:hidden"
          />

          {status === "loading" ? (
            <Loader2 size={16} className="shrink-0 animate-spin text-white/45" />
          ) : null}

          <button
            type="button"
            onClick={onClose}
            aria-label={t("search.close")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/55 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          >
            <X size={17} />
          </button>
        </div>

        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
        >
          {!hasQuery ? (
            <p className="px-3 py-8 text-center text-sm font-semibold text-white/45">
              {t("search.hint")}
            </p>
          ) : status === "failed" ? (
            <p className="px-3 py-8 text-center text-sm font-semibold text-rose-300">
              {t("search.failed")}
            </p>
          ) : flatResults.length === 0 && status === "ready" ? (
            <p className="px-3 py-8 text-center text-sm font-semibold text-white/45">
              {formatTemplate(t("search.noResults"), { query: query.trim() })}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.id} className="mb-2 last:mb-0">
                <p className="px-3 py-2 text-[0.68rem] font-black uppercase tracking-[0.16em] text-[var(--accent)]">
                  {t(group.labelKey)}
                </p>

                <ul className="space-y-1">
                  {group.items.map((item) => {
                    flatIndex += 1;
                    const isActive = flatIndex === activeIndex;
                    const subtitle = getResultSubtitle(item);

                    return (
                      <li key={item.Id}>
                        <button
                          type="button"
                          data-search-active={isActive ? "true" : undefined}
                          onClick={() => openResult(item)}
                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition focus:outline-none focus:ring-2 focus:ring-[var(--accent)] ${
                            isActive
                              ? "bg-white/[0.12]"
                              : "hover:bg-white/[0.08]"
                          }`}
                        >
                          <ResultThumbnail item={item} />

                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-sm font-black text-white">
                              {item.Name}
                            </span>
                            {subtitle ? (
                              <span className="truncate text-[0.7rem] font-bold uppercase tracking-[0.1em] text-white/45">
                                {subtitle}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
