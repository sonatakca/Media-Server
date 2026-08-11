import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlignVerticalSpaceAround,
  ChevronDown,
  ChevronLeft,
  Check,
  ImageIcon,
  Images,
  Languages,
  Loader2,
  Lock,
  RotateCcw,
  Save,
  Search,
  Sparkles,
} from "lucide-react";
import {
  applyItemArtwork,
  clearItemArtwork,
  getItemArtwork,
  getLocalizedMetadataPreview,
  identifyItem,
  saveItemDisplayMetadata,
  searchMetadataCandidates,
  setLogoPlacement,
  type ArtworkCandidate,
  type ArtworkKind,
  type ArtworkOverview,
  type MetadataCandidate,
} from "../lib/artworkApi";
import { getAllMovieAndSeriesItems, getPrimaryImageUrl } from "../lib/mediaApi";
import type { MediaItem } from "../lib/types";
import { getDisplayTitle, formatTemplate } from "../lib/format";
import { setPageTitle } from "../lib/pageTitle";
import {
  DEFAULT_LOGO_PLACEMENT,
  LOGO_PLACEMENTS,
  getLogoPlacement,
  getLogoPlacementLabelKey,
  type LogoPlacement,
} from "../lib/logoPlacement";
import { useLanguage } from "../i18n/LanguageContext";
import {
  ARTWORK_KINDS,
  ARTWORK_PAGE_SIZE,
  filterTitles,
  formatDimensions,
  getArtworkErrorKey,
  getKindDescriptionKey,
  getKindLabelKey,
  getLanguageLabelKey,
  getStatusClasses,
  hasStoredArtwork,
  isArtworkEligible,
  isKindLocked,
  countCandidates,
  nextVisibleCount,
  selectCandidates,
  type ActionStatus,
  type ImageLanguageFilter,
} from "./admin/tmdbArtworkModel";

const LANGUAGE_FILTERS: ImageLanguageFilter[] = ["all", "en", "tr", "none"];
const PREVIEW_LANGUAGES = ["en-US", "tr-TR"] as const;

function errorCodeOf(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code: unknown }).code
    : undefined;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function TmdbArtworkPage() {
  const { t } = useLanguage();

  const [titles, setTitles] = useState<MediaItem[]>([]);
  const [titlesStatus, setTitlesStatus] = useState<ActionStatus>({
    tone: "busy",
    message: t("tmdbArtwork.loadingItems"),
  });
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [artwork, setArtwork] = useState<ArtworkOverview | null>(null);
  const [artworkStatus, setArtworkStatus] = useState<ActionStatus>({
    tone: "idle",
    message: t("tmdbArtwork.noTmdbSelectedDescription"),
  });
  const [languageFilter, setLanguageFilter] =
    useState<ImageLanguageFilter>("all");
  const [busyKind, setBusyKind] = useState<ArtworkKind | null>(null);
  const [visibleCounts, setVisibleCounts] = useState<
    Partial<Record<ArtworkKind, number>>
  >({});
  const [placement, setPlacement] = useState<LogoPlacement>(
    DEFAULT_LOGO_PLACEMENT,
  );
  const [placementStatus, setPlacementStatus] = useState<ActionStatus>({
    tone: "idle",
    message: "",
  });

  const [tmdbQuery, setTmdbQuery] = useState("");
  const [matches, setMatches] = useState<MetadataCandidate[]>([]);
  const [matchStatus, setMatchStatus] = useState<ActionStatus>({
    tone: "idle",
    message: t("tmdbArtwork.selectItemFirst"),
  });

  const [display, setDisplay] = useState({
    title: "",
    originalTitle: "",
    overview: "",
    tagline: "",
  });
  const [displayStatus, setDisplayStatus] = useState<ActionStatus>({
    tone: "idle",
    message: t("tmdbArtwork.itemMetadataRequiresMatch"),
  });

  useEffect(() => {
    setPageTitle(t("tmdbArtwork.title"));
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      try {
        const items = await getAllMovieAndSeriesItems();
        if (!isMounted) return;
        const eligible = items.filter(isArtworkEligible);
        setTitles(eligible);
        setTitlesStatus({
          tone: "success",
          message: formatTemplate(t("tmdbArtwork.loadedItems"), {
            count: eligible.length,
          }),
        });
      } catch (error) {
        if (!isMounted) return;
        setTitlesStatus({
          tone: "error",
          message: messageOf(error, t("tmdbArtwork.couldNotLoadItems")),
        });
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [t]);

  const visibleTitles = useMemo(
    () => filterTitles(titles, search),
    [titles, search],
  );
  const selectedTitle = useMemo(
    () => titles.find((item) => item.Id === selectedId),
    [titles, selectedId],
  );

  const loadArtwork = useCallback(
    async (itemId: string) => {
      setArtworkStatus({ tone: "busy", message: t("tmdbArtwork.loadingImages") });
      try {
        const overview = await getItemArtwork(itemId);
        setArtwork(overview);
        setVisibleCounts({});
        setArtworkStatus({
          tone: "success",
          message: formatTemplate(t("tmdbArtwork.loadedImages"), {
            count: overview.candidates.length,
            target: overview.item.title,
          }),
        });
      } catch (error) {
        setArtwork(null);
        setArtworkStatus({
          tone: "error",
          message: t(getArtworkErrorKey(errorCodeOf(error))),
        });
      }
    },
    [t],
  );

  const selectTitle = useCallback(
    (item: MediaItem) => {
      setSelectedId(item.Id);
      setMatches([]);
      setTmdbQuery(item.Name ?? "");
      setMatchStatus({ tone: "idle", message: "" });
      setDisplay({
        title: item.Name ?? "",
        originalTitle: item.OriginalTitle ?? "",
        overview: item.Overview ?? "",
        tagline: item.Taglines?.[0] ?? "",
      });
      setDisplayStatus({ tone: "idle", message: "" });
      setPlacement(getLogoPlacement(item));
      setPlacementStatus({ tone: "idle", message: "" });
      void loadArtwork(item.Id);
    },
    [loadArtwork],
  );

  async function handleTmdbSearch(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) {
      setMatchStatus({ tone: "error", message: t("tmdbArtwork.selectItemFirst") });
      return;
    }
    if (!tmdbQuery.trim()) {
      setMatchStatus({ tone: "error", message: t("tmdbArtwork.searchRequired") });
      return;
    }

    setMatchStatus({ tone: "busy", message: t("tmdbArtwork.searchingTmdb") });
    try {
      const result = await searchMetadataCandidates(selectedId, tmdbQuery);
      setMatches(result.candidates);
      setMatchStatus({
        tone: result.candidates.length > 0 ? "success" : "idle",
        message:
          result.candidates.length > 0
            ? formatTemplate(t("tmdbArtwork.searchResults"), {
                count: result.candidates.length,
              })
            : t("tmdbArtwork.noSearchResults"),
      });
    } catch (error) {
      setMatchStatus({
        tone: "error",
        message: messageOf(error, t("tmdbArtwork.couldNotSearch")),
      });
    }
  }

  async function handleIdentify(providerId: string) {
    if (!selectedId) return;

    setMatchStatus({ tone: "busy", message: t("tmdbArtwork.identifying") });
    try {
      await identifyItem(selectedId, providerId);
      setMatchStatus({
        tone: "success",
        message: t("tmdbArtwork.identifySaved"),
      });
      await loadArtwork(selectedId);
    } catch (error) {
      setMatchStatus({
        tone: "error",
        message: messageOf(error, t("tmdbArtwork.couldNotIdentify")),
      });
    }
  }

  async function handleApply(kind: ArtworkKind, candidate: ArtworkCandidate) {
    if (!selectedId) return;

    setBusyKind(kind);
    setArtworkStatus({ tone: "busy", message: t("tmdbArtwork.savingArtwork") });
    try {
      await applyItemArtwork(selectedId, { kind, filePath: candidate.filePath });
      setArtworkStatus({
        tone: "success",
        message: formatTemplate(t("tmdbArtwork.artworkSaved"), {
          file: candidate.filePath,
        }),
      });
      await loadArtwork(selectedId);
    } catch (error) {
      setArtworkStatus({
        tone: "error",
        message: messageOf(error, t("tmdbArtwork.couldNotSaveArtwork")),
      });
    } finally {
      setBusyKind(null);
    }
  }

  async function handleRevert(kind: ArtworkKind) {
    if (!selectedId) return;

    setBusyKind(kind);
    setArtworkStatus({
      tone: "busy",
      message: t("tmdbArtwork.revertingArtwork"),
    });
    try {
      await clearItemArtwork(selectedId, kind);
      setArtworkStatus({
        tone: "success",
        message: t("tmdbArtwork.artworkReverted"),
      });
      await loadArtwork(selectedId);
    } catch (error) {
      setArtworkStatus({
        tone: "error",
        message: messageOf(error, t("tmdbArtwork.couldNotRevertArtwork")),
      });
    } finally {
      setBusyKind(null);
    }
  }

  async function handleLoadLocalized(language: string) {
    if (!selectedId) return;

    setDisplayStatus({
      tone: "busy",
      message: t("tmdbArtwork.loadingItemMetadata"),
    });
    try {
      const preview = await getLocalizedMetadataPreview(selectedId, language);
      setDisplay({
        title: preview.title,
        originalTitle: preview.originalTitle ?? "",
        overview: preview.overview ?? "",
        tagline: preview.tagline ?? "",
      });
      setDisplayStatus({
        tone: "success",
        message: t("tmdbArtwork.itemMetadataLoaded"),
      });
    } catch (error) {
      setDisplayStatus({
        tone: "error",
        message:
          errorCodeOf(error) === "PROVIDER_ID_MISSING"
            ? t("tmdbArtwork.itemMetadataRequiresMatch")
            : messageOf(error, t("tmdbArtwork.couldNotLoadItemMetadata")),
      });
    }
  }

  async function handlePlacement(next: LogoPlacement) {
    if (!selectedId) return;

    const previous = placement;
    // Applied first so the buttons answer immediately; a failure puts it back
    // rather than leaving the page claiming a placement the server rejected.
    setPlacement(next);
    setPlacementStatus({ tone: "busy", message: t("logoPlacement.saving") });
    try {
      await setLogoPlacement(selectedId, next);
      setTitles((current) =>
        current.map((entry) =>
          entry.Id === selectedId ? { ...entry, LogoPlacement: next } : entry,
        ),
      );
      setPlacementStatus({ tone: "success", message: t("logoPlacement.saved") });
    } catch (error) {
      setPlacement(previous);
      setPlacementStatus({
        tone: "error",
        message: messageOf(error, t("logoPlacement.couldNotSave")),
      });
    }
  }

  async function handleSaveDisplay(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;

    setDisplayStatus({
      tone: "busy",
      message: t("tmdbArtwork.savingItemMetadata"),
    });
    try {
      await saveItemDisplayMetadata(selectedId, {
        ...(display.title.trim() ? { title: display.title.trim() } : {}),
        ...(display.originalTitle.trim()
          ? { originalTitle: display.originalTitle.trim() }
          : {}),
        ...(display.overview.trim() ? { overview: display.overview.trim() } : {}),
        ...(display.tagline.trim() ? { tagline: display.tagline.trim() } : {}),
        // Locking is what makes the edit stick: without it the next refresh
        // writes the provider's own wording back over it.
        lockFields: ["title", "overview", "tagline"],
      });
      setDisplayStatus({
        tone: "success",
        message: t("tmdbArtwork.itemMetadataSaved"),
      });
    } catch (error) {
      setDisplayStatus({
        tone: "error",
        message: messageOf(error, t("tmdbArtwork.couldNotLoadItemMetadata")),
      });
    }
  }

  return (
    <div className="min-h-screen bg-[#07070b] px-4 py-8 text-white sm:px-8">
      <div className="mx-auto max-w-[1400px]">
        <Link
          to="/dev"
          className="inline-flex items-center gap-2 text-sm font-bold text-white/45 transition hover:text-white/80"
        >
          <ChevronLeft className="h-4 w-4" />
          {t("devtools.title")}
        </Link>

        <header className="mt-6">
          <p className="text-[0.68rem] font-black uppercase tracking-[0.18em] text-sky-300/70">
            {t("tmdbArtwork.eyebrow")}
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-tight">
            {t("tmdbArtwork.title")}
          </h1>
          <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-white/50">
            {t("tmdbArtwork.description")}
          </p>
        </header>

        <div className="mt-8 grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
          <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-4">
            <h2 className="text-sm font-black uppercase tracking-[0.14em] text-white/70">
              {t("tmdbArtwork.jellyfinTitles")}
            </h2>
            <p className={`mt-1 text-xs font-bold ${getStatusClasses(titlesStatus.tone)}`}>
              {titlesStatus.message}
            </p>

            <label className="mt-3 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/40 px-3 py-2">
              <Search className="h-4 w-4 shrink-0 text-white/35" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("tmdbArtwork.itemSearchPlaceholder")}
                className="w-full bg-transparent text-sm font-semibold outline-none placeholder:text-white/25"
              />
            </label>
            <p className="mt-2 text-[0.68rem] font-bold uppercase tracking-[0.12em] text-white/30">
              {formatTemplate(t("tmdbArtwork.visibleItems"), {
                count: visibleTitles.length,
              })}
            </p>

            <ul className="mt-3 max-h-[60vh] space-y-1 overflow-y-auto pr-1">
              {visibleTitles.map((item) => (
                <li key={item.Id}>
                  <button
                    type="button"
                    onClick={() => selectTitle(item)}
                    className={`flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left transition ${
                      item.Id === selectedId
                        ? "bg-sky-400/15 ring-1 ring-sky-300/40"
                        : "hover:bg-white/[0.06]"
                    }`}
                  >
                    <img
                      src={getPrimaryImageUrl(item.Id, item.ImageTags?.Primary, 80)}
                      alt=""
                      loading="lazy"
                      className="h-14 w-10 shrink-0 rounded-lg object-cover"
                    />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold">
                        {getDisplayTitle(item)}
                      </span>
                      <span className="block text-xs font-semibold text-white/35">
                        {item.Type} · {item.ProductionYear ?? "—"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <div className="space-y-6">
            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.14em] text-white/70">
                <Sparkles className="h-4 w-4 text-sky-300/70" />
                {t("tmdbArtwork.tmdbMatch")}
              </h2>

              {!selectedTitle ? (
                <p className="mt-3 text-sm font-bold text-white/40">
                  {t("tmdbArtwork.noItemSelected")}
                </p>
              ) : (
                <>
                  {artwork ? (
                    <p className="mt-2 text-xs font-bold text-emerald-300/80">
                      {formatTemplate(t("tmdbArtwork.selectedTmdb"), {
                        id: artwork.item.providerId,
                      })}
                    </p>
                  ) : null}

                  <form onSubmit={handleTmdbSearch} className="mt-3 flex gap-2">
                    <label className="sr-only" htmlFor="tmdb-query">
                      {t("tmdbArtwork.searchQuery")}
                    </label>
                    <input
                      id="tmdb-query"
                      value={tmdbQuery}
                      onChange={(event) => setTmdbQuery(event.target.value)}
                      placeholder={t("tmdbArtwork.tmdbSearchPlaceholder")}
                      className="flex-1 rounded-2xl border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold outline-none placeholder:text-white/25"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-2 rounded-2xl bg-sky-400/20 px-4 py-2 text-sm font-black text-sky-100 transition hover:bg-sky-400/30"
                    >
                      <Search className="h-4 w-4" />
                      {t("tmdbArtwork.searchQuery")}
                    </button>
                  </form>

                  {matchStatus.message ? (
                    <p className={`mt-2 text-xs font-bold ${getStatusClasses(matchStatus.tone)}`}>
                      {matchStatus.message}
                    </p>
                  ) : null}

                  <ul className="mt-3 space-y-1">
                    {matches.map((match) => (
                      <li key={match.providerId}>
                        <button
                          type="button"
                          onClick={() => void handleIdentify(match.providerId)}
                          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 px-3 py-2 text-left transition hover:border-sky-300/40 hover:bg-sky-400/10"
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-bold">
                              {match.title}
                              {match.year ? ` (${match.year})` : ""}
                            </span>
                            <span className="block text-xs font-semibold text-white/35">
                              TMDB {match.providerId}
                              {match.originalTitle
                                ? ` · ${match.originalTitle}`
                                : ""}
                            </span>
                          </span>
                          <Check className="h-4 w-4 shrink-0 text-white/30" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.14em] text-white/70">
                  <Images className="h-4 w-4 text-sky-300/70" />
                  {t("tmdbArtwork.artworkSelection")}
                </h2>

                <div className="flex items-center gap-2">
                  <Languages className="h-4 w-4 text-white/35" />
                  <label className="sr-only" htmlFor="language-filter">
                    {t("tmdbArtwork.languageFilter")}
                  </label>
                  <select
                    id="language-filter"
                    value={languageFilter}
                    onChange={(event) => {
                      setLanguageFilter(event.target.value as ImageLanguageFilter);
                      // A new filter draws a new pool, so how far the previous
                      // one had been paged through no longer means anything.
                      setVisibleCounts({});
                    }}
                    className="rounded-2xl border border-white/10 bg-black/50 px-3 py-1.5 text-xs font-bold outline-none"
                  >
                    {LANGUAGE_FILTERS.map((filter) => (
                      <option key={filter} value={filter}>
                        {filter === "all"
                          ? t("tmdbArtwork.languageFilter")
                          : t(
                              getLanguageLabelKey(
                                filter === "none" ? null : filter,
                              ),
                            )}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <p className={`mt-2 text-xs font-bold ${getStatusClasses(artworkStatus.tone)}`}>
                {artworkStatus.message}
              </p>

              {!artwork ? (
                <p className="mt-4 text-sm font-bold text-white/40">
                  {t("tmdbArtwork.noTmdbSelected")}
                </p>
              ) : (
                <div className="mt-5 space-y-8">
                  {ARTWORK_KINDS.map((kind) => {
                    const visible = visibleCounts[kind] ?? ARTWORK_PAGE_SIZE;
                    const candidates = selectCandidates(
                      artwork.candidates,
                      kind,
                      languageFilter,
                      visible,
                    );
                    const available = countCandidates(
                      artwork.candidates,
                      kind,
                      languageFilter,
                    );
                    const locked = isKindLocked(artwork.lockedTypes, kind);
                    const stored = hasStoredArtwork(artwork.current, kind);

                    return (
                      <div key={kind}>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h3 className="flex items-center gap-2 text-sm font-black text-white/85">
                              <ImageIcon className="h-4 w-4 text-white/35" />
                              {t(getKindLabelKey(kind))}
                              {locked ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[0.62rem] font-black uppercase tracking-[0.1em] text-amber-200">
                                  <Lock className="h-3 w-3" />
                                  {t("tmdbArtwork.lockedBadge")}
                                </span>
                              ) : null}
                            </h3>
                            <p className="mt-1 text-xs font-semibold text-white/40">
                              {t(getKindDescriptionKey(kind))}
                              {locked ? ` ${t("tmdbArtwork.lockedExplanation")}` : ""}
                            </p>
                            {available > candidates.length ? (
                              <p className="mt-1 text-xs font-bold text-white/30">
                                {formatTemplate(
                                  t("tmdbArtwork.showingTopChoices"),
                                  { shown: candidates.length, total: available },
                                )}
                              </p>
                            ) : null}
                            {!stored ? (
                              <p className="mt-1 text-xs font-bold text-white/30">
                                {t("tmdbArtwork.noCurrentArtwork")}
                              </p>
                            ) : null}
                          </div>

                          {locked ? (
                            <button
                              type="button"
                              disabled={busyKind !== null}
                              onClick={() => void handleRevert(kind)}
                              className="inline-flex items-center gap-2 rounded-2xl border border-white/15 px-3 py-1.5 text-xs font-black text-white/70 transition hover:border-white/30 hover:text-white disabled:opacity-40"
                            >
                              {busyKind === kind ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="h-3.5 w-3.5" />
                              )}
                              {t("tmdbArtwork.revertToAutomatic")}
                            </button>
                          ) : null}
                        </div>

                        {candidates.length === 0 ? (
                          <p className="mt-3 text-sm font-bold text-white/35">
                            {t("tmdbArtwork.noImages")}
                          </p>
                        ) : (
                          <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                            {candidates.map((candidate) => (
                              <li key={candidate.filePath}>
                                <button
                                  type="button"
                                  disabled={busyKind !== null}
                                  onClick={() => void handleApply(kind, candidate)}
                                  className="group w-full overflow-hidden rounded-2xl border border-white/10 bg-black/40 text-left transition hover:border-sky-300/50 disabled:opacity-40"
                                >
                                  <img
                                    src={candidate.previewUrl}
                                    alt=""
                                    loading="lazy"
                                    className={`w-full object-contain ${
                                      kind === "poster" ? "aspect-[2/3]" : "aspect-video"
                                    } ${kind === "logo" ? "bg-white/5 p-2" : ""}`}
                                  />
                                  <span className="block px-2 py-2">
                                    <span className="block text-[0.68rem] font-black uppercase tracking-[0.1em] text-white/45">
                                      {t(getLanguageLabelKey(candidate.language))}
                                    </span>
                                    <span className="block text-[0.68rem] font-semibold text-white/35">
                                      {formatDimensions(
                                        candidate.width,
                                        candidate.height,
                                      )}
                                    </span>
                                    <span className="block text-[0.68rem] font-semibold text-white/35">
                                      {formatTemplate(t("tmdbArtwork.voteSummary"), {
                                        rating: candidate.voteAverage.toFixed(1),
                                        count: candidate.voteCount,
                                      })}
                                    </span>
                                    <span className="mt-1 block text-[0.68rem] font-black text-sky-300/0 transition group-hover:text-sky-300/90">
                                      {t("tmdbArtwork.replaceFile")}
                                    </span>
                                  </span>
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}

                        {available > candidates.length ? (
                          <button
                            type="button"
                            onClick={() =>
                              setVisibleCounts((current) => ({
                                ...current,
                                [kind]: nextVisibleCount(visible, available),
                              }))
                            }
                            className="mt-3 inline-flex items-center gap-2 rounded-2xl border border-white/15 px-4 py-2 text-xs font-black text-white/70 transition hover:border-sky-300/40 hover:text-white"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                            {formatTemplate(t("tmdbArtwork.loadMoreChoices"), {
                              count: Math.min(
                                ARTWORK_PAGE_SIZE,
                                available - candidates.length,
                              ),
                            })}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <h2 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.14em] text-white/70">
                <AlignVerticalSpaceAround className="h-4 w-4 text-sky-300/70" />
                {t("logoPlacement.title")}
              </h2>
              <p className="mt-1 text-xs font-semibold text-white/40">
                {t("logoPlacement.description")}
              </p>

              <div className="mt-3 inline-flex rounded-2xl border border-white/10 bg-black/40 p-1">
                {LOGO_PLACEMENTS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={!selectedId || placementStatus.tone === "busy"}
                    onClick={() => void handlePlacement(option)}
                    className={`rounded-xl px-4 py-1.5 text-xs font-black transition disabled:opacity-40 ${
                      placement === option
                        ? "bg-sky-400/25 text-sky-100"
                        : "text-white/55 hover:text-white"
                    }`}
                  >
                    {t(getLogoPlacementLabelKey(option))}
                    {option === DEFAULT_LOGO_PLACEMENT
                      ? ` · ${t("logoPlacement.default")}`
                      : ""}
                  </button>
                ))}
              </div>

              {placementStatus.message ? (
                <p className={`mt-2 text-xs font-bold ${getStatusClasses(placementStatus.tone)}`}>
                  {placementStatus.message}
                </p>
              ) : null}
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/[0.03] p-5">
              <h2 className="text-sm font-black uppercase tracking-[0.14em] text-white/70">
                {t("tmdbArtwork.itemMetadata")}
              </h2>
              <p className="mt-1 text-xs font-semibold text-white/40">
                {t("tmdbArtwork.itemLanguagesDescription")}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                {PREVIEW_LANGUAGES.map((language) => (
                  <button
                    key={language}
                    type="button"
                    disabled={!selectedId}
                    onClick={() => void handleLoadLocalized(language)}
                    className="inline-flex items-center gap-2 rounded-2xl border border-white/15 px-3 py-1.5 text-xs font-black text-white/75 transition hover:border-sky-300/40 hover:text-white disabled:opacity-40"
                  >
                    <Languages className="h-3.5 w-3.5" />
                    {t("tmdbArtwork.loadItemMetadata")} ·{" "}
                    {t(getLanguageLabelKey(language.slice(0, 2)))}
                  </button>
                ))}
              </div>

              {displayStatus.message ? (
                <p className={`mt-2 text-xs font-bold ${getStatusClasses(displayStatus.tone)}`}>
                  {displayStatus.message}
                </p>
              ) : null}

              <form onSubmit={handleSaveDisplay} className="mt-4 space-y-3">
                <input
                  value={display.title}
                  onChange={(event) =>
                    setDisplay((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder={t("tmdbArtwork.itemLanguages")}
                  className="w-full rounded-2xl border border-white/10 bg-black/40 px-3 py-2 text-sm font-bold outline-none placeholder:text-white/25"
                />
                <input
                  value={display.tagline}
                  onChange={(event) =>
                    setDisplay((current) => ({ ...current, tagline: event.target.value }))
                  }
                  placeholder={t("common.details")}
                  className="w-full rounded-2xl border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold outline-none placeholder:text-white/25"
                />
                <textarea
                  value={display.overview}
                  onChange={(event) =>
                    setDisplay((current) => ({ ...current, overview: event.target.value }))
                  }
                  rows={5}
                  className="w-full rounded-2xl border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold leading-6 outline-none"
                />
                <button
                  type="submit"
                  disabled={!selectedId}
                  className="inline-flex items-center gap-2 rounded-2xl bg-emerald-400/20 px-4 py-2 text-sm font-black text-emerald-100 transition hover:bg-emerald-400/30 disabled:opacity-40"
                >
                  <Save className="h-4 w-4" />
                  {t("tmdbArtwork.saveItemDisplay")}
                </button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
