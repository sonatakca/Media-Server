import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Clapperboard,
  Film,
  ImageIcon,
  Images,
  Languages,
  Loader2,
  Save,
  Search,
  Sparkles,
  Tv,
} from "lucide-react";
import {
  getAllMovieAndSeriesItems,
  getPrimaryImageUrl,
} from "../lib/jellyfinApi";
import type { JellyfinItem } from "../lib/types";
import {
  getDisplayTitle,
  getItemSubtitle,
  formatTemplate,
} from "../lib/format";
import { setPageTitle } from "../lib/pageTitle";
import {
  applyTmdbArtwork,
  getTmdbArtworkImages,
  isTmdbArtworkBackendConfigured,
  searchTmdbArtwork,
  type TmdbArtworkImage,
  type TmdbArtworkKind,
  type TmdbMediaType,
  type TmdbSearchResult,
} from "../lib/tmdbArtworkApi";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";

type ActionState = "idle" | "loading" | "success" | "error";
type Translate = (key: TranslationKey) => string;

interface ActionResult {
  state: ActionState;
  message: string;
}

const ARTWORK_KINDS: TmdbArtworkKind[] = [
  "poster",
  "backdrop",
  "landscape",
  "logo",
];

const TARGET_FILE_BY_KIND: Record<TmdbArtworkKind, string> = {
  poster: "folder.jpg",
  backdrop: "backdrop.jpg",
  landscape: "landscape.jpg",
  logo: "logo.png",
};

function createEmptyResult(): ActionResult {
  return {
    state: "idle",
    message: "",
  };
}

function getTypeLabel(item: JellyfinItem, t: Translate) {
  if (item.Type === "Movie") return t("common.movie");
  if (item.Type === "Series") return t("common.series");
  return item.Type ?? t("common.item");
}

function getMediaTypeForItem(item: JellyfinItem): TmdbMediaType {
  return item.Type === "Series" ? "tv" : "movie";
}

function getTmdbIdFromItem(item: JellyfinItem): number | null {
  const providerIds = item.ProviderIds ?? {};
  const rawTmdbId =
    providerIds.Tmdb ?? providerIds.TMDB ?? providerIds.tmdb ?? null;
  const parsed = rawTmdbId ? Number(rawTmdbId) : NaN;

  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function createTmdbResultFromProvider(
  item: JellyfinItem,
): TmdbSearchResult | null {
  const tmdbId = getTmdbIdFromItem(item);

  if (!tmdbId) {
    return null;
  }

  return {
    id: tmdbId,
    mediaType: getMediaTypeForItem(item),
    title: getDisplayTitle(item),
    originalTitle: item.OriginalTitle ?? null,
    overview: item.Overview ?? null,
    year: item.ProductionYear ?? null,
    date: item.PremiereDate ?? null,
    posterPath: null,
    backdropPath: null,
    posterPreviewUrl: null,
    backdropPreviewUrl: null,
    voteAverage: null,
    popularity: null,
  };
}

function getKindLabel(kind: TmdbArtworkKind, t: Translate): string {
  if (kind === "poster") return t("tmdbArtwork.kind.poster");
  if (kind === "backdrop") return t("tmdbArtwork.kind.backdrop");
  if (kind === "landscape") return t("tmdbArtwork.kind.landscape");
  return t("tmdbArtwork.kind.logo");
}

function getKindDescription(kind: TmdbArtworkKind, t: Translate): string {
  if (kind === "poster") return t("tmdbArtwork.kind.posterDescription");
  if (kind === "backdrop") return t("tmdbArtwork.kind.backdropDescription");
  if (kind === "landscape") return t("tmdbArtwork.kind.landscapeDescription");
  return t("tmdbArtwork.kind.logoDescription");
}

function getLanguageLabel(
  language: TmdbArtworkImage["language"],
  t: Translate,
) {
  if (language === "en") return t("tmdbArtwork.language.english");
  if (language === "tr") return t("tmdbArtwork.language.turkish");
  return t("tmdbArtwork.language.none");
}

function formatDimensions(image: TmdbArtworkImage, t: Translate): string {
  if (!image.width || !image.height) {
    return t("common.unknown");
  }

  return `${image.width} x ${image.height}`;
}

function getResultSubtitle(result: TmdbSearchResult, t: Translate): string {
  return [
    result.mediaType === "tv" ? t("common.series") : t("common.movie"),
    result.year?.toString(),
    result.voteAverage ? result.voteAverage.toFixed(1) : undefined,
  ]
    .filter(Boolean)
    .join(" / ");
}

function getStatusClasses(state: ActionState): string {
  if (state === "error") {
    return "border-red-400/20 bg-red-400/10 text-red-100";
  }

  if (state === "success") {
    return "border-emerald-400/20 bg-emerald-400/10 text-emerald-100";
  }

  return "border-white/10 bg-white/[0.06] text-white/62";
}

function getSearchableText(item: JellyfinItem): string {
  return [
    item.Name,
    item.SortName,
    item.OriginalTitle,
    item.Type,
    item.ProductionYear,
    ...(item.Genres ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function TmdbArtworkPage() {
  const { language, t } = useLanguage();
  const [items, setItems] = useState<JellyfinItem[]>([]);
  const [selectedItem, setSelectedItem] = useState<JellyfinItem | null>(null);
  const [itemSearch, setItemSearch] = useState("");
  const [tmdbSearch, setTmdbSearch] = useState("");
  const [tmdbYear, setTmdbYear] = useState("");
  const [tmdbMediaType, setTmdbMediaType] = useState<TmdbMediaType>("movie");
  const [tmdbResults, setTmdbResults] = useState<TmdbSearchResult[]>([]);
  const [selectedTmdb, setSelectedTmdb] = useState<TmdbSearchResult | null>(
    null,
  );
  const [activeKind, setActiveKind] = useState<TmdbArtworkKind>("poster");
  const [imagesByKind, setImagesByKind] = useState<
    Partial<Record<TmdbArtworkKind, TmdbArtworkImage[]>>
  >({});
  const [selectedImages, setSelectedImages] = useState<
    Partial<Record<TmdbArtworkKind, TmdbArtworkImage>>
  >({});
  const [loadState, setLoadState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [searchState, setSearchState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [imagesState, setImagesState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [applyState, setApplyState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );

  const backendConfigured = isTmdbArtworkBackendConfigured();

  useEffect(() => {
    setPageTitle(
      `${t("tmdbArtwork.title")} · ${t("devtools.title")} · Seyirlik`,
      {
        canonicalPath: "/dev/tmdb-artwork",
        robots: "noindex, nofollow",
      },
    );
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    async function loadItems() {
      setLoadState({
        state: "loading",
        message: t("tmdbArtwork.loadingItems"),
      });

      try {
        const nextItems = await getAllMovieAndSeriesItems();

        if (!isMounted) return;

        setItems(nextItems);
        setLoadState({
          state: "success",
          message: formatTemplate(t("tmdbArtwork.loadedItems"), {
            count: nextItems.length,
          }),
        });
      } catch (error) {
        if (!isMounted) return;

        setLoadState({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : t("tmdbArtwork.couldNotLoadItems"),
        });
      }
    }

    void loadItems();

    return () => {
      isMounted = false;
    };
  }, [t]);

  const visibleItems = useMemo(() => {
    const trimmedSearch = itemSearch.trim().toLowerCase();

    return items
      .filter((item) =>
        trimmedSearch ? getSearchableText(item).includes(trimmedSearch) : true,
      )
      .sort((left, right) =>
        getDisplayTitle(left).localeCompare(getDisplayTitle(right), undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
  }, [items, itemSearch]);

  const activeImages = imagesByKind[activeKind] ?? [];
  const activeSelectedImage = selectedImages[activeKind] ?? null;

  const loadImagesForKind = useCallback(
    async (tmdbResult: TmdbSearchResult, kind: TmdbArtworkKind) => {
      setImagesState({
        state: "loading",
        message: t("tmdbArtwork.loadingImages"),
      });

      try {
        const images = await getTmdbArtworkImages({
          mediaType: tmdbResult.mediaType,
          tmdbId: tmdbResult.id,
          kind,
          language,
        });

        setImagesByKind((current) => ({
          ...current,
          [kind]: images,
        }));
        setSelectedImages((current) => ({
          ...current,
          [kind]: current[kind] ?? images[0],
        }));
        setImagesState({
          state: images.length > 0 ? "success" : "idle",
          message:
            images.length > 0
              ? formatTemplate(t("tmdbArtwork.loadedImages"), {
                  count: images.length,
                  target: TARGET_FILE_BY_KIND[kind],
                })
              : t("tmdbArtwork.noImages"),
        });
      } catch (error) {
        setImagesByKind((current) => ({
          ...current,
          [kind]: [],
        }));
        setImagesState({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : t("tmdbArtwork.couldNotLoadImages"),
        });
      }
    },
    [language, t],
  );

  useEffect(() => {
    if (!selectedTmdb) {
      return;
    }

    if (imagesByKind[activeKind]) {
      return;
    }

    void loadImagesForKind(selectedTmdb, activeKind);
  }, [activeKind, imagesByKind, loadImagesForKind, selectedTmdb]);

  const selectItem = (item: JellyfinItem) => {
    const providerResult = createTmdbResultFromProvider(item);

    setSelectedItem(item);
    setTmdbMediaType(getMediaTypeForItem(item));
    setTmdbSearch(getDisplayTitle(item));
    setTmdbYear(item.ProductionYear ? String(item.ProductionYear) : "");
    setTmdbResults([]);
    setSelectedTmdb(providerResult);
    setImagesByKind({});
    setSelectedImages({});
    setSearchState(createEmptyResult());
    setImagesState(createEmptyResult());
    setApplyState(createEmptyResult());

    if (providerResult) {
      void loadImagesForKind(providerResult, activeKind);
    }
  };

  const handleSearchTmdb = async (event?: FormEvent) => {
    event?.preventDefault();

    if (!selectedItem || !tmdbSearch.trim()) {
      setSearchState({
        state: "error",
        message: t("tmdbArtwork.searchRequired"),
      });
      return;
    }

    setSearchState({
      state: "loading",
      message: t("tmdbArtwork.searchingTmdb"),
    });

    try {
      const results = await searchTmdbArtwork({
        mediaType: tmdbMediaType,
        query: tmdbSearch.trim(),
        year: /^\d{4}$/.test(tmdbYear.trim())
          ? Number(tmdbYear.trim())
          : undefined,
        language,
      });

      setTmdbResults(results);
      setSearchState({
        state: results.length > 0 ? "success" : "idle",
        message:
          results.length > 0
            ? formatTemplate(t("tmdbArtwork.searchResults"), {
                count: results.length,
              })
            : t("tmdbArtwork.noSearchResults"),
      });
    } catch (error) {
      setSearchState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("tmdbArtwork.couldNotSearch"),
      });
    }
  };

  const selectTmdbResult = (result: TmdbSearchResult) => {
    setSelectedTmdb(result);
    setImagesByKind({});
    setSelectedImages({});
    setApplyState(createEmptyResult());
    void loadImagesForKind(result, activeKind);
  };

  const handleApplyArtwork = async () => {
    if (!selectedItem || !activeSelectedImage) return;

    setApplyState({
      state: "loading",
      message: t("tmdbArtwork.savingArtwork"),
    });

    try {
      const result = await applyTmdbArtwork({
        itemId: selectedItem.Id,
        kind: activeKind,
        filePath: activeSelectedImage.filePath,
      });

      setApplyState({
        state: "success",
        message: formatTemplate(t("tmdbArtwork.artworkSaved"), {
          file: result.targetFileName,
        }),
      });
    } catch (error) {
      setApplyState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("tmdbArtwork.couldNotSaveArtwork"),
      });
    }
  };

  return (
    <div className="relative mx-auto max-w-7xl space-y-6">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] shadow-2xl backdrop-blur-xl">
        <div className="relative p-6 sm:p-7">
          <div className="pointer-events-none absolute -right-16 -top-24 h-56 w-56 rounded-full bg-[var(--accent)]/20 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-28 left-10 h-56 w-56 rounded-full bg-white/10 blur-3xl" />

          <Link
            to="/dev"
            className="relative inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/25 px-3 py-2 text-sm font-bold text-white/66 transition hover:border-[var(--accent)]/35 hover:text-white"
          >
            <ArrowLeft size={16} />
            {t("devtools.backToDevtools")}
          </Link>

          <div className="relative mt-6 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
                {t("tmdbArtwork.eyebrow")}
              </p>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
                  <Images size={23} />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-white sm:text-4xl">
                    {t("tmdbArtwork.title")}
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-white/52">
                    {t("tmdbArtwork.description")}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex w-fit items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-sm font-black text-white/58">
              <Languages size={17} />
              {t("tmdbArtwork.languageFilter")}
            </div>
          </div>

          {!backendConfigured ? (
            <p className="relative mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm font-bold text-amber-100">
              {t("tmdbArtwork.backendMissing")}
            </p>
          ) : null}
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[0.9fr_1.35fr]">
        <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                <Clapperboard size={15} />
                {t("tmdbArtwork.jellyfinTitles")}
              </p>
              <h2 className="mt-2 text-xl font-black text-white">
                {formatTemplate(t("tmdbArtwork.visibleItems"), {
                  count: visibleItems.length,
                })}
              </h2>
            </div>
          </div>

          <label className="mt-5 block">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              {t("common.search")}
            </span>
            <div className="relative mt-2">
              <Search
                size={16}
                className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30"
              />
              <input
                value={itemSearch}
                onChange={(event) => setItemSearch(event.target.value)}
                placeholder={t("tmdbArtwork.itemSearchPlaceholder")}
                className="w-full rounded-2xl border border-white/10 bg-white/[0.06] py-3 pl-10 pr-4 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
              />
            </div>
          </label>

          {loadState.message ? (
            <p
              className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${getStatusClasses(
                loadState.state,
              )}`}
            >
              {loadState.message}
            </p>
          ) : null}

          <div className="mt-5 max-h-[48rem] space-y-2 overflow-y-auto pr-1">
            {visibleItems.map((item) => {
              const isSelected = selectedItem?.Id === item.Id;
              const imageTag = item.ImageTags?.Primary;

              return (
                <button
                  key={item.Id}
                  type="button"
                  onClick={() => selectItem(item)}
                  className={`w-full rounded-3xl border p-3 text-left transition ${
                    isSelected
                      ? "border-[var(--accent)]/45 bg-[var(--accent)]/12"
                      : "border-white/10 bg-white/[0.045] hover:border-[var(--accent)]/30 hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="flex gap-3">
                    <div className="h-24 w-16 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
                      {imageTag ? (
                        <img
                          src={getPrimaryImageUrl(item.Id, imageTag, 240)}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-white/25">
                          {item.Type === "Series" ? (
                            <Tv size={20} />
                          ) : (
                            <Film size={20} />
                          )}
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 flex-1 py-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="w-fit rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-xs font-black uppercase tracking-[0.12em] text-white/42">
                          {getTypeLabel(item, t)}
                        </p>

                        {isSelected ? (
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-black">
                            <Check size={15} />
                          </span>
                        ) : null}
                      </div>

                      <h3 className="mt-2 truncate text-base font-black text-white">
                        {getDisplayTitle(item)}
                      </h3>
                      <p className="mt-1 line-clamp-2 text-sm font-medium leading-6 text-white/50">
                        {getItemSubtitle(item) ?? item.Overview ?? item.Id}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="space-y-5">
          <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                  <Sparkles size={15} />
                  {t("tmdbArtwork.tmdbMatch")}
                </p>
                <h2 className="mt-2 text-xl font-black text-white">
                  {selectedItem
                    ? getDisplayTitle(selectedItem)
                    : t("tmdbArtwork.noItemSelected")}
                </h2>
                <p className="mt-1 text-sm font-semibold text-white/45">
                  {selectedTmdb
                    ? formatTemplate(t("tmdbArtwork.selectedTmdb"), {
                        id: selectedTmdb.id,
                      })
                    : t("tmdbArtwork.selectItemFirst")}
                </p>
              </div>
            </div>

            <form
              onSubmit={(event) => void handleSearchTmdb(event)}
              className="mt-5 grid gap-3 lg:grid-cols-[1fr_8rem_9rem_auto]"
            >
              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                  {t("tmdbArtwork.searchQuery")}
                </span>
                <input
                  value={tmdbSearch}
                  onChange={(event) => setTmdbSearch(event.target.value)}
                  disabled={!selectedItem}
                  placeholder={t("tmdbArtwork.tmdbSearchPlaceholder")}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 disabled:cursor-not-allowed disabled:opacity-55"
                />
              </label>

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                  {t("common.year")}
                </span>
                <input
                  value={tmdbYear}
                  onChange={(event) => setTmdbYear(event.target.value)}
                  disabled={!selectedItem}
                  inputMode="numeric"
                  maxLength={4}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition focus:border-[var(--accent)]/50 disabled:cursor-not-allowed disabled:opacity-55"
                />
              </label>

              <label className="block">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                  {t("common.type")}
                </span>
                <select
                  value={tmdbMediaType}
                  onChange={(event) =>
                    setTmdbMediaType(event.target.value as TmdbMediaType)
                  }
                  disabled={!selectedItem}
                  className="mt-2 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm font-bold text-white outline-none transition focus:border-[var(--accent)]/50 disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <option value="movie">{t("common.movie")}</option>
                  <option value="tv">{t("common.series")}</option>
                </select>
              </label>

              <button
                type="submit"
                disabled={
                  !selectedItem ||
                  !backendConfigured ||
                  searchState.state === "loading"
                }
                className="mt-6 inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60 lg:mt-auto"
              >
                {searchState.state === "loading" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Search size={18} />
                )}
                {t("common.search")}
              </button>
            </form>

            {searchState.message ? (
              <p
                className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${getStatusClasses(
                  searchState.state,
                )}`}
              >
                {searchState.message}
              </p>
            ) : null}

            {tmdbResults.length > 0 ? (
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {tmdbResults.map((result) => {
                  const isSelected =
                    selectedTmdb?.id === result.id &&
                    selectedTmdb.mediaType === result.mediaType;

                  return (
                    <button
                      key={`${result.mediaType}-${result.id}`}
                      type="button"
                      onClick={() => selectTmdbResult(result)}
                      className={`overflow-hidden rounded-3xl border text-left transition ${
                        isSelected
                          ? "border-[var(--accent)]/45 bg-[var(--accent)]/12"
                          : "border-white/10 bg-white/[0.045] hover:border-[var(--accent)]/30 hover:bg-white/[0.07]"
                      }`}
                    >
                      <div className="flex gap-3 p-3">
                        <div className="h-28 w-20 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
                          {result.posterPreviewUrl ? (
                            <img
                              src={result.posterPreviewUrl}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-white/25">
                              <ImageIcon size={20} />
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1 py-1">
                          <div className="flex items-start justify-between gap-3">
                            <p className="text-base font-black text-white">
                              {result.title}
                            </p>
                            {isSelected ? (
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-black">
                                <Check size={15} />
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-sm font-bold text-white/45">
                            {getResultSubtitle(result, t)}
                          </p>
                          <p className="mt-2 line-clamp-2 text-sm font-medium leading-6 text-white/48">
                            {result.overview ??
                              result.originalTitle ??
                              result.id}
                          </p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>

          <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                  <Images size={15} />
                  {t("tmdbArtwork.artworkSelection")}
                </p>
                <h2 className="mt-2 text-xl font-black text-white">
                  {getKindLabel(activeKind, t)}{" "}
                  <span className="text-white/45">
                    / {TARGET_FILE_BY_KIND[activeKind]}
                  </span>
                </h2>
                <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-white/45">
                  {getKindDescription(activeKind, t)}
                </p>
              </div>

              <button
                type="button"
                onClick={handleApplyArtwork}
                disabled={
                  !selectedItem ||
                  !activeSelectedImage ||
                  applyState.state === "loading"
                }
                className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {applyState.state === "loading" ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Save size={18} />
                )}
                {t("tmdbArtwork.replaceFile")}
              </button>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-4">
              {ARTWORK_KINDS.map((kind) => {
                const isActive = activeKind === kind;
                const selectedImage = selectedImages[kind];

                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => setActiveKind(kind)}
                    className={`rounded-2xl border px-3 py-3 text-left transition ${
                      isActive
                        ? "border-[var(--accent)]/45 bg-[var(--accent)] text-black"
                        : "border-white/10 bg-white/[0.055] text-white/56 hover:border-white/20 hover:text-white"
                    }`}
                  >
                    <span className="block text-sm font-black">
                      {getKindLabel(kind, t)}
                    </span>
                    <span
                      className={`mt-1 block truncate text-xs font-bold ${
                        isActive ? "text-black/62" : "text-white/35"
                      }`}
                    >
                      {selectedImage?.filePath ?? TARGET_FILE_BY_KIND[kind]}
                    </span>
                  </button>
                );
              })}
            </div>

            {imagesState.message ? (
              <p
                className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${getStatusClasses(
                  imagesState.state,
                )}`}
              >
                {imagesState.message}
              </p>
            ) : null}

            {applyState.message ? (
              <p
                className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${getStatusClasses(
                  applyState.state,
                )}`}
              >
                {applyState.message}
              </p>
            ) : null}

            {!selectedTmdb ? (
              <div className="mt-5 flex min-h-72 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.035] p-6 text-center">
                <div>
                  <ImageIcon className="mx-auto text-white/28" size={34} />
                  <p className="mt-3 text-lg font-black text-white">
                    {t("tmdbArtwork.noTmdbSelected")}
                  </p>
                  <p className="mt-1 max-w-md text-sm font-semibold leading-6 text-white/45">
                    {t("tmdbArtwork.noTmdbSelectedDescription")}
                  </p>
                </div>
              </div>
            ) : imagesState.state === "loading" && activeImages.length === 0 ? (
              <div className="mt-5 flex min-h-72 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.035] p-6">
                <div className="text-center">
                  <Loader2
                    className="mx-auto animate-spin text-[var(--accent)]"
                    size={34}
                  />
                  <p className="mt-3 text-sm font-black uppercase tracking-[0.16em] text-white/48">
                    {t("tmdbArtwork.loadingImages")}
                  </p>
                </div>
              </div>
            ) : activeImages.length > 0 ? (
              <div
                className={`mt-5 grid gap-3 ${
                  activeKind === "poster"
                    ? "sm:grid-cols-3 xl:grid-cols-4"
                    : "md:grid-cols-2 xl:grid-cols-3"
                }`}
              >
                {activeImages.map((image) => {
                  const isSelected =
                    activeSelectedImage?.filePath === image.filePath;

                  return (
                    <button
                      key={image.id}
                      type="button"
                      onClick={() =>
                        setSelectedImages((current) => ({
                          ...current,
                          [activeKind]: image,
                        }))
                      }
                      className={`overflow-hidden rounded-3xl border text-left transition ${
                        isSelected
                          ? "border-[var(--accent)]/55 bg-[var(--accent)]/12"
                          : "border-white/10 bg-white/[0.045] hover:border-[var(--accent)]/30 hover:bg-white/[0.07]"
                      }`}
                    >
                      <div
                        className={`relative bg-white/[0.04] ${
                          activeKind === "poster"
                            ? "aspect-[2/3]"
                            : "aspect-video"
                        }`}
                      >
                        <img
                          src={image.previewUrl}
                          alt=""
                          className={`h-full w-full ${
                            activeKind === "logo"
                              ? "object-contain p-6"
                              : "object-cover"
                          }`}
                        />
                        {isSelected ? (
                          <span className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-[var(--accent)] text-black shadow-2xl">
                            <Check size={16} />
                          </span>
                        ) : null}
                      </div>

                      <div className="space-y-2 p-3">
                        <div className="flex flex-wrap gap-2">
                          <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-black uppercase tracking-[0.1em] text-white/48">
                            {getLanguageLabel(image.language, t)}
                          </span>
                          <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-black uppercase tracking-[0.1em] text-white/48">
                            {formatDimensions(image, t)}
                          </span>
                        </div>

                        <p className="truncate text-sm font-bold text-white/68">
                          {image.filePath}
                        </p>
                        <p className="text-xs font-bold text-white/38">
                          {formatTemplate(t("tmdbArtwork.voteSummary"), {
                            rating: image.voteAverage?.toFixed(1) ?? "-",
                            count: image.voteCount ?? 0,
                          })}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-5 flex min-h-72 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.035] p-6 text-center">
                <div>
                  <ImageIcon className="mx-auto text-white/28" size={34} />
                  <p className="mt-3 text-lg font-black text-white">
                    {t("tmdbArtwork.noImages")}
                  </p>
                </div>
              </div>
            )}
          </section>
        </section>
      </section>
    </div>
  );
}
