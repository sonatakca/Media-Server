import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  DatabaseZap,
  FilePenLine,
  FolderSearch,
  ImageIcon,
  Loader2,
  RefreshCcw,
  Save,
  Search,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import {
  getAllSeriesEpisodes,
  getVideoItemsForLibrary,
  getItem,
  getUserViews,
  refreshItemMetadata,
  refreshLibraryMetadata,
  scanAllLibraries,
  updateItemMetadata,
  getBackdropImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
  getTrickplayImageUrl,
} from "../lib/jellyfinApi";
import type {
  JellyfinItem,
  JellyfinLibrary,
  JellyfinMediaStream,
  JellyfinMetadataRefreshMode,
} from "../lib/types";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import { setPageTitle } from "../lib/pageTitle";
import {
  getDefaultSubtitleStreamIndexForItem,
  saveDefaultSubtitleStreamPreferences,
} from "../lib/subtitlePreferences";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";

type ActionState = "idle" | "loading" | "success" | "error";
type Translate = (key: TranslationKey) => string;

interface ActionResult {
  state: ActionState;
  message: string;
}

interface MetadataDraft {
  name: string;
  sortName: string;
  overview: string;
  productionYear: string;
  officialRating: string;
  communityRating: string;
  genres: string;
}

interface SubtitlePreferenceOption {
  index: number;
  stream: JellyfinMediaStream;
  itemCount: number;
}

const MIXED_SUBTITLE_PREFERENCE_INDEX = -2;

function createEmptyResult(): ActionResult {
  return {
    state: "idle",
    message: "",
  };
}

function createDraftFromItem(item: JellyfinItem): MetadataDraft {
  return {
    name: item.Name ?? "",
    sortName: item.SortName ?? "",
    overview: item.Overview ?? "",
    productionYear: item.ProductionYear ? String(item.ProductionYear) : "",
    officialRating: item.OfficialRating ?? "",
    communityRating:
      typeof item.CommunityRating === "number"
        ? String(item.CommunityRating)
        : "",
    genres: item.Genres?.join(", ") ?? "",
  };
}

function getDefaultSubtitlePreferenceIndex(item: JellyfinItem): number {
  return getDefaultSubtitleStreamIndexForItem(item);
}

function getSubtitleStreams(item: JellyfinItem | null): JellyfinMediaStream[] {
  return (
    item?.MediaSources?.[0]?.MediaStreams?.filter(
      (stream) => stream.Type?.toLowerCase() === "subtitle",
    ) ?? []
  );
}

function getSubtitleStreamLabel(
  stream: JellyfinMediaStream,
  fallback: string,
  t: Translate,
): string {
  const detailParts = [
    stream.DisplayTitle,
    stream.Title,
    stream.Language?.toUpperCase(),
    stream.Codec?.toUpperCase(),
    stream.IsExternal ? t("maintenance.external") : undefined,
    stream.IsDefault ? t("common.default") : undefined,
    stream.IsForced ? t("maintenance.forced") : undefined,
  ].filter(Boolean);
  const uniqueDetails = Array.from(new Set(detailParts));
  const streamPrefix =
    stream.Index !== undefined ? `#${stream.Index}` : fallback;

  return uniqueDetails.length > 0
    ? `${streamPrefix} · ${uniqueDetails.join(" · ")}`
    : streamPrefix;
}

function getCommonSubtitlePreferenceIndex(items: JellyfinItem[]): number {
  if (items.length === 0) return -1;

  const firstPreference = getDefaultSubtitlePreferenceIndex(items[0]);

  return items.every(
    (item) => getDefaultSubtitlePreferenceIndex(item) === firstPreference,
  )
    ? firstPreference
    : MIXED_SUBTITLE_PREFERENCE_INDEX;
}

function getSubtitlePreferenceOptions(
  items: JellyfinItem[],
): SubtitlePreferenceOption[] {
  const optionsByIndex = new Map<number, SubtitlePreferenceOption>();

  items.forEach((item) => {
    const seenIndexes = new Set<number>();

    getSubtitleStreams(item).forEach((stream) => {
      if (stream.Index === undefined || seenIndexes.has(stream.Index)) return;

      seenIndexes.add(stream.Index);

      const existingOption = optionsByIndex.get(stream.Index);

      if (existingOption) {
        existingOption.itemCount += 1;
      } else {
        optionsByIndex.set(stream.Index, {
          index: stream.Index,
          stream,
          itemCount: 1,
        });
      }
    });
  });

  return Array.from(optionsByIndex.values()).sort(
    (left, right) => left.index - right.index,
  );
}

function getSubtitlePreferenceTargetItems(
  selectedItem: JellyfinItem | null,
  seriesEpisodes: JellyfinItem[],
): JellyfinItem[] {
  if (!selectedItem) return [];
  if (selectedItem.Type === "Series") return seriesEpisodes;
  return [selectedItem];
}

function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

function getTypeLabel(item: JellyfinItem, t: Translate) {
  if (item.Type === "Movie") return t("common.movie");
  if (item.Type === "Episode") return t("common.episode");
  if (item.Type === "Series") return t("common.series");
  if (item.Type === "Season") return t("common.season");
  if (item.Type === "Folder") return t("common.folder");
  return item.Type ?? t("common.item");
}

function parseNumberOrUndefined(value: string): number | undefined {
  const trimmed = value.trim();

  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseGenres(value: string): string[] {
  return value
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean);
}

function formatBoolean(value: boolean | undefined, t: Translate): string {
  if (value === true) return t("common.yes");
  if (value === false) return t("common.no");
  return t("common.unknown");
}

function formatBytes(
  value: number | undefined,
  unknownLabel = "Unknown",
): string {
  if (!value || value <= 0) return unknownLabel;

  const units = ["B", "KB", "MB", "GB", "TB"];
  let nextValue = value;
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  return `${nextValue.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatBitrate(
  value: number | undefined,
  unknownLabel = "Unknown",
): string {
  if (!value || value <= 0) return unknownLabel;
  return `${(value / 1_000_000).toFixed(2)} Mbps`;
}

function formatTicks(value: number | undefined, t: Translate): string {
  if (!value || value <= 0) return t("common.unknown");

  const totalSeconds = Math.floor(value / 10_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function getDetailValue(value: unknown, t: Translate): string {
  if (value === undefined || value === null || value === "") {
    return t("common.unknown");
  }

  if (typeof value === "boolean") return formatBoolean(value, t);
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : t("common.none");
  }

  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function DetailRow({ label, value }: { label: string; value: unknown }) {
  const { t } = useLanguage();

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-3">
      <p className="text-[0.68rem] font-black uppercase tracking-[0.14em] text-white/35">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm font-bold leading-6 text-white/72">
        {getDetailValue(value, t)}
      </p>
    </div>
  );
}

// Helper to add a timeout to a library load
async function withLibraryLoadTimeout<T>(
  promise: Promise<T>,
  label: string,
  t: Translate,
): Promise<T> {
  let timeoutId: number | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(
        new Error(
          formatTemplate(t("maintenance.libraryLoadTimeout"), { label }),
        ),
      );
    }, 15000);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
  }
}

export function LibraryMaintenancePage() {
  const { t } = useLanguage();
  const [libraries, setLibraries] = useState<JellyfinLibrary[]>([]);
  const [items, setItems] = useState<JellyfinItem[]>([]);
  const [itemLibraryById, setItemLibraryById] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [selectedItem, setSelectedItem] = useState<JellyfinItem | null>(null);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [trickplayStatus, setTrickplayStatus] = useState<
    "unknown" | "loading" | "available" | "missing"
  >("unknown");

  const [libraryId, setLibraryId] = useState("all");
  const [search, setSearch] = useState("");
  const selectedEpisodeLibraryId = libraryId.startsWith("episodes:")
    ? libraryId.slice("episodes:".length)
    : null;

  const selectedLibraryId = selectedEpisodeLibraryId ?? libraryId;
  const [metadataRefreshMode, setMetadataRefreshMode] =
    useState<JellyfinMetadataRefreshMode>("Default");
  const [replaceAllMetadata, setReplaceAllMetadata] = useState(false);
  const [replaceAllImages, setReplaceAllImages] = useState(false);

  const [loadState, setLoadState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [scanState, setScanState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [itemRefreshState, setItemRefreshState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [saveState, setSaveState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [selectedDefaultSubtitleIndex, setSelectedDefaultSubtitleIndex] =
    useState(-1);
  const [seriesSubtitleEpisodes, setSeriesSubtitleEpisodes] = useState<
    JellyfinItem[]
  >([]);
  const [isLoadingSeriesSubtitleEpisodes, setIsLoadingSeriesSubtitleEpisodes] =
    useState(false);
  const [subtitlePreferenceState, setSubtitlePreferenceState] =
    useState<ActionResult>(() => createEmptyResult());
  const subtitlePreferenceRequestIdRef = useRef(0);

  useEffect(() => {
    setPageTitle(
      `${t("maintenance.title")} · ${t("devtools.title")} · Seyirlik`,
      {
        canonicalPath: "/dev/library-maintenance",
        robots: "noindex, nofollow",
      },
    );
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      setLoadState({
        state: "loading",
        message: t("maintenance.loadingLibraries"),
      });

      try {
        const nextLibraries = await getUserViews();

        if (!isMounted) return;

        setLibraries(nextLibraries);

        const libraryItemResults = await Promise.allSettled(
          nextLibraries.map(async (library) => {
            const libraryItems = await withLibraryLoadTimeout(
              getVideoItemsForLibrary(library.Id),
              library.Name ?? library.Id,
              t,
            );

            return {
              library,
              items: libraryItems,
            };
          }),
        );

        if (!isMounted) return;

        const nextItemLibraryById = new Map<string, string>();
        const uniqueItemsById = new Map<string, JellyfinItem>();
        const failedLibraries: string[] = [];

        for (const result of libraryItemResults) {
          if (result.status === "rejected") {
            failedLibraries.push(
              result.reason instanceof Error
                ? result.reason.message
                : t("maintenance.libraryFailedToLoad"),
            );
            continue;
          }

          for (const item of result.value.items) {
            uniqueItemsById.set(item.Id, item);
            nextItemLibraryById.set(item.Id, result.value.library.Id);
          }
        }

        const nextVideoItems = Array.from(uniqueItemsById.values());

        setItems(nextVideoItems);
        setItemLibraryById(nextItemLibraryById);

        setLoadState({
          state: failedLibraries.length > 0 ? "error" : "success",
          message:
            failedLibraries.length > 0
              ? formatTemplate(t("maintenance.loadedWithFailures"), {
                  count: nextVideoItems.length,
                  failedCount: failedLibraries.length,
                  libraryLabel: t(
                    failedLibraries.length === 1
                      ? "maintenance.librarySingular"
                      : "maintenance.libraryPlural",
                  ),
                  failures: failedLibraries.join(" | "),
                })
              : formatTemplate(
                  t(
                    nextVideoItems.length === 1
                      ? "maintenance.loadedItemsSingular"
                      : "maintenance.loadedItemsPlural",
                  ),
                  { count: nextVideoItems.length },
                ),
        });
      } catch (error) {
        if (!isMounted) return;

        setLoadState({
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : t("maintenance.couldNotLoadData"),
        });
      }
    }

    void loadInitialData();

    return () => {
      isMounted = false;
    };
  }, [t]);

  const visibleItems = useMemo(() => {
    const trimmedSearch = search.trim().toLowerCase();

    return items
      .filter((item) => {
        if (
          selectedLibraryId !== "all" &&
          itemLibraryById.get(item.Id) !== selectedLibraryId
        ) {
          return false;
        }

        if (selectedEpisodeLibraryId && item.Type !== "Episode") {
          return false;
        }

        if (
          !selectedEpisodeLibraryId &&
          selectedLibraryId !== "all" &&
          item.Type === "Episode"
        ) {
          return false;
        }

        if (!trimmedSearch) {
          return true;
        }

        const searchable = [
          item.Name,
          item.SortName,
          item.SeriesName,
          item.SeasonName,
          item.Type,
          item.Overview,
          ...(item.Genres ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return searchable.includes(trimmedSearch);
      })
      .sort((a, b) => getDisplayTitle(a).localeCompare(getDisplayTitle(b)));
  }, [
    items,
    selectedLibraryId,
    selectedEpisodeLibraryId,
    search,
    itemLibraryById,
  ]);

  const libraryOptions = useMemo(() => {
    const options: Array<{ id: string; label: string }> = [
      { id: "all", label: t("maintenance.allLibraries") },
    ];

    for (const library of libraries) {
      options.push({
        id: library.Id,
        label: library.Name ?? t("maintenance.unnamedLibrary"),
      });

      if ((library.Name ?? "").toLocaleLowerCase("tr-TR").includes("dizi")) {
        options.push({
          id: `episodes:${library.Id}`,
          label: t("common.episodes"),
        });
      }
    }

    return options;
  }, [libraries, t]);

  const subtitlePreferenceTargetItems = useMemo(
    () =>
      getSubtitlePreferenceTargetItems(selectedItem, seriesSubtitleEpisodes),
    [selectedItem, seriesSubtitleEpisodes],
  );

  const selectedSubtitleOptions = useMemo(
    () => getSubtitlePreferenceOptions(subtitlePreferenceTargetItems),
    [subtitlePreferenceTargetItems],
  );

  const loadSubtitlePreferenceTargets = async (item: JellyfinItem) => {
    const requestId = subtitlePreferenceRequestIdRef.current + 1;
    subtitlePreferenceRequestIdRef.current = requestId;

    if (item.Type !== "Series") {
      setSeriesSubtitleEpisodes([]);
      setIsLoadingSeriesSubtitleEpisodes(false);
      setSelectedDefaultSubtitleIndex(getDefaultSubtitlePreferenceIndex(item));
      return;
    }

    setSeriesSubtitleEpisodes([]);
    setIsLoadingSeriesSubtitleEpisodes(true);
    setSelectedDefaultSubtitleIndex(-1);

    try {
      const episodes = await getAllSeriesEpisodes(item.Id);

      if (subtitlePreferenceRequestIdRef.current !== requestId) return;

      setSeriesSubtitleEpisodes(episodes);
      setSelectedDefaultSubtitleIndex(
        getCommonSubtitlePreferenceIndex(episodes),
      );
    } catch (error) {
      if (subtitlePreferenceRequestIdRef.current !== requestId) return;

      setSeriesSubtitleEpisodes([]);
      setSelectedDefaultSubtitleIndex(-1);
      setSubtitlePreferenceState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("maintenance.couldNotLoadSeriesEpisodes"),
      });
    } finally {
      if (subtitlePreferenceRequestIdRef.current === requestId) {
        setIsLoadingSeriesSubtitleEpisodes(false);
      }
    }
  };

  const selectItem = async (item: JellyfinItem) => {
    setSelectedItem(item);
    setDraft(createDraftFromItem(item));
    setSelectedDefaultSubtitleIndex(
      item.Type === "Series" ? -1 : getDefaultSubtitlePreferenceIndex(item),
    );
    setSeriesSubtitleEpisodes([]);
    setIsLoadingSeriesSubtitleEpisodes(item.Type === "Series");
    setSaveState(createEmptyResult());
    setSubtitlePreferenceState(createEmptyResult());
    setItemRefreshState(createEmptyResult());
    setTrickplayStatus("loading");

    let currentItem = item;

    try {
      const freshItem = await getItem(item.Id);
      currentItem = freshItem;
      setSelectedItem(freshItem);
      setDraft(createDraftFromItem(freshItem));
    } catch {
      // Keep the existing loaded item if the detail refresh fails.
    }

    void loadSubtitlePreferenceTargets(currentItem);

    const mediaSourceId = item.MediaSources?.[0]?.Id;

    if (!mediaSourceId) {
      setTrickplayStatus("missing");
      return;
    }

    const probeImage = new Image();
    probeImage.onload = () => setTrickplayStatus("available");
    probeImage.onerror = () => setTrickplayStatus("missing");
    probeImage.src = getTrickplayImageUrl(item.Id, mediaSourceId, 320, 0);
  };

  const handleScanAll = async () => {
    setScanState({
      state: "loading",
      message: t("maintenance.startingFullScan"),
    });

    try {
      await scanAllLibraries();
      setScanState({
        state: "success",
        message: t("maintenance.fullScanStarted"),
      });
    } catch (error) {
      setScanState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("maintenance.couldNotStartScan"),
      });
    }
  };

  const handleScanSelectedLibrary = async () => {
    if (libraryId === "all") {
      await handleScanAll();
      return;
    }

    setScanState({
      state: "loading",
      message: t("maintenance.startingSelectedScan"),
    });

    try {
      await refreshLibraryMetadata(selectedLibraryId);
      setScanState({
        state: "success",
        message: t("maintenance.selectedScanStarted"),
      });
    } catch (error) {
      setScanState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("maintenance.couldNotScanSelected"),
      });
    }
  };

  const handleRefreshSelectedItem = async () => {
    if (!selectedItem) return;

    setItemRefreshState({
      state: "loading",
      message: t("maintenance.refreshingSelected"),
    });

    try {
      await refreshItemMetadata(selectedItem.Id, {
        metadataRefreshMode,
        imageRefreshMode: metadataRefreshMode,
        replaceAllMetadata,
        replaceAllImages,
      });

      const refreshed = await getItem(selectedItem.Id);
      setSelectedItem(refreshed);
      setDraft(createDraftFromItem(refreshed));
      void loadSubtitlePreferenceTargets(refreshed);
      setItems((currentItems) =>
        currentItems.map((item) =>
          item.Id === refreshed.Id ? refreshed : item,
        ),
      );

      setItemRefreshState({
        state: "success",
        message: t("maintenance.refreshStarted"),
      });
    } catch (error) {
      setItemRefreshState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("maintenance.couldNotRefresh"),
      });
    }
  };

  const handleSaveMetadata = async (event: FormEvent) => {
    event.preventDefault();

    if (!selectedItem || !draft) return;

    const name = draft.name.trim();

    if (!name) {
      setSaveState({
        state: "error",
        message: t("maintenance.nameCannotBeEmpty"),
      });
      return;
    }

    setSaveState({
      state: "loading",
      message: t("maintenance.savingMetadata"),
    });

    try {
      const updatedItem: JellyfinItem = {
        ...selectedItem,
        Name: name,
        SortName: draft.sortName.trim() || undefined,
        Overview: draft.overview.trim() || undefined,
        ProductionYear: parseNumberOrUndefined(draft.productionYear),
        OfficialRating: draft.officialRating.trim() || undefined,
        CommunityRating: parseNumberOrUndefined(draft.communityRating),
        Genres: parseGenres(draft.genres),
      };

      await updateItemMetadata(selectedItem.Id, updatedItem);

      const refreshed = await getItem(selectedItem.Id);
      setSelectedItem(refreshed);
      setDraft(createDraftFromItem(refreshed));
      void loadSubtitlePreferenceTargets(refreshed);
      setItems((currentItems) =>
        currentItems.map((item) =>
          item.Id === refreshed.Id ? refreshed : item,
        ),
      );

      setSaveState({
        state: "success",
        message: t("maintenance.metadataSaved"),
      });
    } catch (error) {
      setSaveState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("maintenance.couldNotSave"),
      });
    }
  };

  const handleSaveSubtitlePreference = () => {
    if (!selectedItem) return;
    if (selectedDefaultSubtitleIndex === MIXED_SUBTITLE_PREFERENCE_INDEX) {
      setSubtitlePreferenceState({
        state: "error",
        message: t("maintenance.chooseSubtitlePreferenceToSave"),
      });
      return;
    }

    const targetItems = getSubtitlePreferenceTargetItems(
      selectedItem,
      seriesSubtitleEpisodes,
    );

    if (targetItems.length === 0) {
      setSubtitlePreferenceState({
        state: "error",
        message:
          selectedItem.Type === "Series"
            ? t("maintenance.noSeriesEpisodes")
            : t("maintenance.noMediaSourceForSubtitlePreference"),
      });
      return;
    }

    const oldDefaultSubtitleIndex =
      selectedItem.Type === "Series"
        ? getCommonSubtitlePreferenceIndex(targetItems)
        : getDefaultSubtitlePreferenceIndex(selectedItem);
    const nextDefaultSubtitleIndex = selectedDefaultSubtitleIndex;

    setSubtitlePreferenceState({
      state: "loading",
      message: t("maintenance.savingSubtitlePreference"),
    });

    if (import.meta.env.DEV) {
      console.info("[Seyirlik Maintenance] Saving subtitle preference", {
        itemId: selectedItem.Id,
        targetItemIds: targetItems.map((item) => item.Id),
        oldDefaultSubtitleStreamIndex: oldDefaultSubtitleIndex,
        newDefaultSubtitleStreamIndex: nextDefaultSubtitleIndex,
      });
    }

    try {
      saveDefaultSubtitleStreamPreferences(
        targetItems.map((item) => ({
          itemId: item.Id,
          subtitleStreamIndex: nextDefaultSubtitleIndex,
        })),
      );

      setSelectedDefaultSubtitleIndex(nextDefaultSubtitleIndex);

      setSubtitlePreferenceState({
        state: "success",
        message:
          selectedItem.Type === "Series"
            ? formatTemplate(
                t("maintenance.subtitlePreferenceSavedForEpisodes"),
                { count: targetItems.length },
              )
            : t("maintenance.subtitlePreferenceSaved"),
      });
    } catch (error) {
      setSubtitlePreferenceState({
        state: "error",
        message:
          error instanceof Error
            ? error.message
            : t("maintenance.couldNotSaveSubtitlePreference"),
      });
    }
  };

  const selectedMediaSource = selectedItem?.MediaSources?.[0];
  const isSelectedSeries = selectedItem?.Type === "Series";
  const canEditSubtitlePreference = Boolean(
    selectedItem &&
    (isSelectedSeries
      ? !isLoadingSeriesSubtitleEpisodes && seriesSubtitleEpisodes.length > 0
      : selectedMediaSource),
  );
  const canSaveSubtitlePreference =
    canEditSubtitlePreference &&
    selectedDefaultSubtitleIndex !== MIXED_SUBTITLE_PREFERENCE_INDEX &&
    subtitlePreferenceState.state !== "loading";
  const hasSelectedSubtitleOption =
    selectedDefaultSubtitleIndex === -1 ||
    selectedDefaultSubtitleIndex === MIXED_SUBTITLE_PREFERENCE_INDEX ||
    selectedSubtitleOptions.some(
      (option) => option.index === selectedDefaultSubtitleIndex,
    );

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
            {t("maintenance.back")}
          </Link>

          <div className="relative mt-6 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
                {t("maintenance.eyebrow")}
              </p>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
                  <DatabaseZap size={23} />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-white sm:text-4xl">
                    {t("maintenance.title")}
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-white/52">
                    {t("maintenance.description")}
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleScanAll}
              disabled={scanState.state === "loading"}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {scanState.state === "loading" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <RefreshCcw size={18} />
              )}
              {t("maintenance.scanAllLibraries")}
            </button>
          </div>

          {scanState.message ? (
            <p
              className={`relative mt-5 rounded-2xl border px-4 py-3 text-sm font-bold ${
                scanState.state === "error"
                  ? "border-red-400/20 bg-red-400/10 text-red-100"
                  : scanState.state === "success"
                    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                    : "border-white/10 bg-white/[0.06] text-white/62"
              }`}
            >
              {scanState.message}
            </p>
          ) : null}
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[0.95fr_1.2fr]">
        <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                <FolderSearch size={15} />
                {t("maintenance.libraryItems")}
              </p>
              <h2 className="mt-2 text-xl font-black text-white">
                {formatTemplate(
                  t(
                    visibleItems.length === 1
                      ? "maintenance.visibleItemSingular"
                      : "maintenance.visibleItemPlural",
                  ),
                  { count: visibleItems.length },
                )}
              </h2>
            </div>

            <button
              type="button"
              onClick={handleScanSelectedLibrary}
              disabled={scanState.state === "loading"}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-black text-white/72 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {scanState.state === "loading" ? (
                <Loader2 size={17} className="animate-spin" />
              ) : (
                <RefreshCcw size={17} />
              )}
              {t("maintenance.scanSelected")}
            </button>
          </div>

          <div className="mt-5 grid gap-4">
            <div className="block">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                {t("library.library")}
              </span>

              <div className="mt-2 flex flex-wrap gap-2">
                {libraryOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setLibraryId(option.id)}
                    className={`rounded-full border px-3 py-2 text-xs font-black uppercase tracking-[0.1em] transition ${
                      libraryId === option.id
                        ? "border-[var(--accent)]/45 bg-[var(--accent)] text-black"
                        : "border-white/10 bg-white/[0.055] text-white/50 hover:border-white/20 hover:text-white"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="block">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                {t("common.search")}
              </span>
              <div className="relative mt-2">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30"
                />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("maintenance.searchPlaceholder")}
                  className="w-full rounded-2xl border border-white/10 bg-white/[0.06] py-3 pl-10 pr-4 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                />
              </div>
            </label>
          </div>

          {loadState.message ? (
            <p
              className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${
                loadState.state === "error"
                  ? "border-red-400/20 bg-red-400/10 text-red-100"
                  : loadState.state === "success"
                    ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                    : "border-white/10 bg-white/[0.06] text-white/62"
              }`}
            >
              {loadState.message}
            </p>
          ) : null}

          <div className="mt-5 max-h-[42rem] space-y-2 overflow-y-auto pr-1">
            {visibleItems.map((item) => {
              const isSelected = selectedItem?.Id === item.Id;

              return (
                <button
                  key={item.Id}
                  type="button"
                  onClick={() => void selectItem(item)}
                  className={`w-full rounded-3xl border p-4 text-left transition ${
                    isSelected
                      ? "border-[var(--accent)]/45 bg-[var(--accent)]/12"
                      : "border-white/10 bg-white/[0.045] hover:border-[var(--accent)]/30 hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="w-fit rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-xs font-black uppercase tracking-[0.12em] text-white/42">
                        {getTypeLabel(item, t)}
                      </p>

                      <h3 className="mt-3 truncate text-base font-black text-white">
                        {getDisplayTitle(item)}
                      </h3>

                      <p className="mt-1 line-clamp-2 text-sm font-medium leading-6 text-white/50">
                        {getItemSubtitle(item) ||
                          item.Overview ||
                          t("maintenance.noSubtitleAvailable")}
                      </p>
                    </div>

                    {isSelected ? (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-black">
                        <Check size={16} />
                      </div>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
          {selectedItem && draft ? (
            <>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                    <FilePenLine size={15} />
                    {t("maintenance.metadataEditor")}
                  </p>
                  <h2 className="mt-2 text-xl font-black text-white">
                    {getDisplayTitle(selectedItem)}
                  </h2>
                  <p className="mt-1 text-sm font-semibold text-white/45">
                    {selectedItem.Id}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleRefreshSelectedItem}
                  disabled={itemRefreshState.state === "loading"}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-black text-white/72 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {itemRefreshState.state === "loading" ? (
                    <Loader2 size={17} className="animate-spin" />
                  ) : (
                    <WandSparkles size={17} />
                  )}
                  {t("maintenance.refreshMetadata")}
                </button>
              </div>

              <div className="mt-5 grid gap-3 rounded-3xl border border-white/10 bg-white/[0.04] p-4 sm:grid-cols-3">
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    {t("maintenance.metadataMode")}
                  </span>
                  <select
                    value={metadataRefreshMode}
                    onChange={(event) =>
                      setMetadataRefreshMode(
                        event.target.value as JellyfinMetadataRefreshMode,
                      )
                    }
                    className="mt-2 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm font-bold text-white outline-none transition focus:border-[var(--accent)]/50"
                  >
                    <option value="Default">{t("common.default")}</option>
                    <option value="FullRefresh">
                      {t("maintenance.fullRefresh")}
                    </option>
                    <option value="None">{t("common.none")}</option>
                  </select>
                </label>

                <label className="flex items-end gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <input
                    type="checkbox"
                    checked={replaceAllMetadata}
                    onChange={(event) =>
                      setReplaceAllMetadata(event.target.checked)
                    }
                    className="h-5 w-5 accent-[var(--accent)]"
                  />
                  <span className="text-sm font-black text-white/72">
                    {t("maintenance.replaceMetadata")}
                  </span>
                </label>

                <label className="flex items-end gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <input
                    type="checkbox"
                    checked={replaceAllImages}
                    onChange={(event) =>
                      setReplaceAllImages(event.target.checked)
                    }
                    className="h-5 w-5 accent-[var(--accent)]"
                  />
                  <span className="text-sm font-black text-white/72">
                    {t("maintenance.replaceImages")}
                  </span>
                </label>
              </div>

              {itemRefreshState.message ? (
                <p
                  className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${
                    itemRefreshState.state === "error"
                      ? "border-red-400/20 bg-red-400/10 text-red-100"
                      : itemRefreshState.state === "success"
                        ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                        : "border-white/10 bg-white/[0.06] text-white/62"
                  }`}
                >
                  {itemRefreshState.message}
                </p>
              ) : null}

              <section className="mt-5 rounded-3xl border border-white/10 bg-white/[0.045] p-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                      {t("maintenance.defaultSubtitlePreference")}
                    </p>
                    <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-white/48">
                      {t(
                        isSelectedSeries
                          ? "maintenance.defaultSubtitlePreferenceSeriesDescription"
                          : "maintenance.defaultSubtitlePreferenceDescription",
                      )}
                    </p>

                    <label className="mt-4 block">
                      <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                        {t("maintenance.defaultSubtitleIndex")}
                      </span>
                      <select
                        value={String(selectedDefaultSubtitleIndex)}
                        disabled={!canEditSubtitlePreference}
                        onChange={(event) =>
                          setSelectedDefaultSubtitleIndex(
                            Number(event.target.value),
                          )
                        }
                        className="mt-2 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm font-bold text-white outline-none transition focus:border-[var(--accent)]/50 disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        {selectedDefaultSubtitleIndex ===
                        MIXED_SUBTITLE_PREFERENCE_INDEX ? (
                          <option
                            value={String(MIXED_SUBTITLE_PREFERENCE_INDEX)}
                          >
                            {t("maintenance.subtitlePreferenceMixed")}
                          </option>
                        ) : null}
                        <option value="-1">
                          {t("maintenance.subtitlePreferenceOff")}
                        </option>
                        {!hasSelectedSubtitleOption ? (
                          <option value={String(selectedDefaultSubtitleIndex)}>
                            {formatTemplate(
                              t("maintenance.subtitleTrackMissing"),
                              { index: selectedDefaultSubtitleIndex },
                            )}
                          </option>
                        ) : null}
                        {selectedSubtitleOptions.map((option, index) => (
                          <option
                            key={`${option.index}-${option.stream.DisplayTitle ?? index}`}
                            value={option.index}
                          >
                            {[
                              getSubtitleStreamLabel(
                                option.stream,
                                formatTemplate(t("settings.subtitle"), {
                                  number: index + 1,
                                }),
                                t,
                              ),
                              isSelectedSeries
                                ? formatTemplate(
                                    t(
                                      option.itemCount === 1
                                        ? "media.episodeSingular"
                                        : "media.episodePlural",
                                    ),
                                    { count: option.itemCount },
                                  )
                                : undefined,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </option>
                        ))}
                      </select>
                    </label>

                    {isLoadingSeriesSubtitleEpisodes ? (
                      <p className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm font-bold text-white/50">
                        {t("maintenance.loadingSeriesEpisodes")}
                      </p>
                    ) : isSelectedSeries &&
                      seriesSubtitleEpisodes.length === 0 ? (
                      <p className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm font-bold text-white/50">
                        {t("maintenance.noSeriesEpisodes")}
                      </p>
                    ) : selectedSubtitleOptions.length === 0 ? (
                      <p className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm font-bold text-white/50">
                        {t("maintenance.noSubtitleStreams")}
                      </p>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveSubtitlePreference}
                    disabled={!canSaveSubtitlePreference}
                    className="inline-flex min-h-12 shrink-0 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {subtitlePreferenceState.state === "loading" ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Save size={18} />
                    )}
                    {t("maintenance.saveSubtitlePreference")}
                  </button>
                </div>

                {subtitlePreferenceState.message ? (
                  <p
                    className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${
                      subtitlePreferenceState.state === "error"
                        ? "border-red-400/20 bg-red-400/10 text-red-100"
                        : subtitlePreferenceState.state === "success"
                          ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                          : "border-white/10 bg-white/[0.06] text-white/62"
                    }`}
                  >
                    {subtitlePreferenceState.message}
                  </p>
                ) : null}
              </section>

              <section className="mt-5 space-y-4 rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                <div>
                  <p className="text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                    {t("maintenance.displayMetadataPreview")}
                  </p>
                  <h3 className="mt-2 text-lg font-black text-white">
                    {t("maintenance.previewTitle")}
                  </h3>
                  <p className="mt-1 text-sm font-semibold leading-6 text-white/45">
                    {t("maintenance.previewDescription")}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-[2/3] bg-white/[0.04]">
                      <img
                        src={getPrimaryImageUrl(
                          selectedItem.Id,
                          selectedItem.ImageTags?.Primary,
                          600,
                        )}
                        alt={`${getDisplayTitle(selectedItem)} primary poster`}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <p className="px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/45">
                      {t("maintenance.primaryPoster")}
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-video bg-white/[0.04]">
                      {selectedItem.BackdropImageTags?.[0] ? (
                        <img
                          src={getBackdropImageUrl(
                            selectedItem.Id,
                            selectedItem.BackdropImageTags[0],
                            900,
                          )}
                          alt={`${getDisplayTitle(selectedItem)} backdrop`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm font-bold text-white/35">
                          {t("maintenance.noBackdrop")}
                        </div>
                      )}
                    </div>
                    <p className="px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/45">
                      {t("maintenance.backdropBanner")}
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-video bg-white/[0.04] p-4">
                      {selectedItem.ImageTags?.Logo ||
                      selectedItem.ParentLogoImageTag ? (
                        <img
                          src={getLogoImageUrl(
                            selectedItem.ImageTags?.Logo
                              ? selectedItem.Id
                              : (selectedItem.ParentLogoItemId ??
                                  selectedItem.Id),
                            selectedItem.ImageTags?.Logo ??
                              selectedItem.ParentLogoImageTag,
                            900,
                          )}
                          alt={`${getDisplayTitle(selectedItem)} logo`}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm font-bold text-white/35">
                          {t("maintenance.noLogo")}
                        </div>
                      )}
                    </div>
                    <p className="px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/45">
                      {t("maintenance.logo")}
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-video bg-white/[0.04]">
                      {selectedItem.MediaSources?.[0]?.Id ? (
                        <img
                          src={getTrickplayImageUrl(
                            selectedItem.Id,
                            selectedItem.MediaSources[0].Id,
                            320,
                            0,
                          )}
                          alt={`${getDisplayTitle(selectedItem)} trickplay sample`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm font-bold text-white/35">
                          {t("maintenance.noMediaSource")}
                        </div>
                      )}
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-xs font-black uppercase tracking-[0.12em] text-white/45">
                        {t("maintenance.trickplaySample")}
                      </p>
                      <p
                        className={`mt-1 text-xs font-black ${
                          trickplayStatus === "available"
                            ? "text-emerald-200"
                            : trickplayStatus === "missing"
                              ? "text-amber-200"
                              : "text-white/42"
                        }`}
                      >
                        {trickplayStatus === "available"
                          ? t("maintenance.trickplayAvailable")
                          : trickplayStatus === "missing"
                            ? t("maintenance.trickplayMissing")
                            : t("maintenance.checking")}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <DetailRow
                    label={t("maintenance.itemId")}
                    value={selectedItem.Id}
                  />
                  <DetailRow
                    label={t("common.type")}
                    value={selectedItem.Type}
                  />
                  <DetailRow
                    label={t("maintenance.mediaType")}
                    value={selectedItem.MediaType}
                  />
                  <DetailRow
                    label={t("maintenance.sortName")}
                    value={selectedItem.SortName}
                  />
                  <DetailRow
                    label={t("maintenance.productionYear")}
                    value={selectedItem.ProductionYear}
                  />
                  <DetailRow
                    label={t("maintenance.officialRating")}
                    value={selectedItem.OfficialRating}
                  />
                  <DetailRow
                    label={t("maintenance.communityRating")}
                    value={selectedItem.CommunityRating}
                  />
                  <DetailRow
                    label={t("common.runtime")}
                    value={formatTicks(selectedItem.RunTimeTicks, t)}
                  />
                  <DetailRow
                    label={t("maintenance.genres")}
                    value={selectedItem.Genres}
                  />
                  <DetailRow
                    label={t("maintenance.primaryImageTag")}
                    value={selectedItem.ImageTags?.Primary}
                  />
                  <DetailRow
                    label={t("maintenance.logoImageTag")}
                    value={
                      selectedItem.ImageTags?.Logo ??
                      selectedItem.ParentLogoImageTag
                    }
                  />
                  <DetailRow
                    label={t("maintenance.backdropImageTags")}
                    value={selectedItem.BackdropImageTags}
                  />
                  <DetailRow
                    label={t("maintenance.parentId")}
                    value={selectedItem.ParentId}
                  />
                  <DetailRow
                    label={t("maintenance.seriesId")}
                    value={selectedItem.SeriesId}
                  />
                  <DetailRow
                    label={t("maintenance.seasonId")}
                    value={selectedItem.SeasonId}
                  />
                  <DetailRow
                    label={t("maintenance.userPlayed")}
                    value={selectedItem.UserData?.Played}
                  />
                  <DetailRow
                    label={t("maintenance.playbackPosition")}
                    value={formatTicks(
                      selectedItem.UserData?.PlaybackPositionTicks,
                      t,
                    )}
                  />
                  <DetailRow
                    label={t("maintenance.chapters")}
                    value={
                      selectedItem.Chapters?.length
                        ? formatTemplate(
                            t(
                              selectedItem.Chapters.length === 1
                                ? "maintenance.chapterSingular"
                                : "maintenance.chapterPlural",
                            ),
                            { count: selectedItem.Chapters.length },
                          )
                        : t("common.none")
                    }
                  />
                </div>

                {selectedItem.MediaSources?.[0] ? (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <DetailRow
                      label={t("maintenance.mediaSourceId")}
                      value={selectedItem.MediaSources[0].Id}
                    />
                    <DetailRow
                      label={t("maintenance.path")}
                      value={selectedItem.MediaSources[0].Path}
                    />
                    <DetailRow
                      label={t("details.container")}
                      value={selectedItem.MediaSources[0].Container}
                    />
                    <DetailRow
                      label={t("maintenance.size")}
                      value={formatBytes(
                        selectedItem.MediaSources[0].Size,
                        t("common.unknown"),
                      )}
                    />
                    <DetailRow
                      label={t("maintenance.bitrate")}
                      value={formatBitrate(
                        selectedItem.MediaSources[0].Bitrate,
                        t("common.unknown"),
                      )}
                    />
                    <DetailRow
                      label={t("maintenance.directPlay")}
                      value={selectedItem.MediaSources[0].SupportsDirectPlay}
                    />
                    <DetailRow
                      label={t("maintenance.directStream")}
                      value={selectedItem.MediaSources[0].SupportsDirectStream}
                    />
                    <DetailRow
                      label={t("maintenance.transcoding")}
                      value={selectedItem.MediaSources[0].SupportsTranscoding}
                    />
                    <DetailRow
                      label={t("maintenance.defaultAudioIndex")}
                      value={
                        selectedItem.MediaSources[0].DefaultAudioStreamIndex
                      }
                    />
                    <DetailRow
                      label={t("maintenance.defaultSubtitleIndex")}
                      value={
                        selectedItem.MediaSources[0].DefaultSubtitleStreamIndex
                      }
                    />
                  </div>
                ) : null}

                {selectedItem.MediaSources?.[0]?.MediaStreams?.length ? (
                  <div className="space-y-3">
                    <p className="text-sm font-black uppercase tracking-[0.18em] text-white/38">
                      {t("maintenance.mediaStreams")}
                    </p>

                    {selectedItem.MediaSources[0].MediaStreams.map((stream) => (
                      <div
                        key={`${stream.Type}-${stream.Index}`}
                        className="rounded-2xl border border-white/10 bg-black/25 p-4"
                      >
                        <p className="text-sm font-black text-white">
                          {stream.Type ?? t("maintenance.streamFallback")}{" "}
                          {stream.Index !== undefined ? `#${stream.Index}` : ""}
                        </p>
                        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                          <DetailRow
                            label={t("maintenance.codec")}
                            value={stream.Codec}
                          />
                          <DetailRow
                            label={t("maintenance.profile")}
                            value={stream.Profile}
                          />
                          <DetailRow
                            label={t("maintenance.language")}
                            value={stream.Language}
                          />
                          <DetailRow
                            label={t("maintenance.displayTitle")}
                            value={stream.DisplayTitle}
                          />
                          <DetailRow
                            label={t("common.default")}
                            value={stream.IsDefault}
                          />
                          <DetailRow
                            label={t("maintenance.forced")}
                            value={stream.IsForced}
                          />
                          <DetailRow
                            label={t("maintenance.external")}
                            value={stream.IsExternal}
                          />
                          <DetailRow
                            label={t("maintenance.channels")}
                            value={stream.Channels}
                          />
                          <DetailRow
                            label={t("maintenance.bitrate")}
                            value={formatBitrate(
                              stream.BitRate,
                              t("common.unknown"),
                            )}
                          />
                          <DetailRow
                            label={t("maintenance.resolution")}
                            value={
                              stream.Width && stream.Height
                                ? `${stream.Width}×${stream.Height}`
                                : t("common.unknown")
                            }
                          />
                          <DetailRow
                            label={t("maintenance.frameRate")}
                            value={
                              stream.AverageFrameRate ?? stream.RealFrameRate
                            }
                          />
                          <DetailRow
                            label={t("maintenance.videoRange")}
                            value={stream.VideoRangeType ?? stream.VideoRange}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>

              <form onSubmit={handleSaveMetadata} className="mt-5 space-y-4">
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    {t("common.name")}
                  </span>
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, name: event.target.value }
                          : current,
                      )
                    }
                    className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    {t("maintenance.sortName")}
                  </span>
                  <input
                    value={draft.sortName}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, sortName: event.target.value }
                          : current,
                      )
                    }
                    className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    {t("details.overview")}
                  </span>
                  <textarea
                    value={draft.overview}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, overview: event.target.value }
                          : current,
                      )
                    }
                    rows={8}
                    className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                      {t("common.year")}
                    </span>
                    <input
                      value={draft.productionYear}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? { ...current, productionYear: event.target.value }
                            : current,
                        )
                      }
                      className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                      {t("maintenance.rating")}
                    </span>
                    <input
                      value={draft.officialRating}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? { ...current, officialRating: event.target.value }
                            : current,
                        )
                      }
                      placeholder={t("maintenance.ratingPlaceholder")}
                      className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                      {t("maintenance.communityRating")}
                    </span>
                    <input
                      value={draft.communityRating}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                communityRating: event.target.value,
                              }
                            : current,
                        )
                      }
                      placeholder={t("maintenance.communityRatingPlaceholder")}
                      className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    {t("maintenance.genres")}
                  </span>
                  <input
                    value={draft.genres}
                    onChange={(event) =>
                      setDraft((current) =>
                        current
                          ? { ...current, genres: event.target.value }
                          : current,
                      )
                    }
                    placeholder={t("maintenance.genresPlaceholder")}
                    className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                  />
                </label>

                {saveState.message ? (
                  <p
                    className={`rounded-2xl border px-4 py-3 text-sm font-bold ${
                      saveState.state === "error"
                        ? "border-red-400/20 bg-red-400/10 text-red-100"
                        : saveState.state === "success"
                          ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-100"
                          : "border-white/10 bg-white/[0.06] text-white/62"
                    }`}
                  >
                    {saveState.message}
                  </p>
                ) : null}

                <button
                  type="submit"
                  disabled={saveState.state === "loading"}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-5 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saveState.state === "loading" ? (
                    <Loader2 size={18} className="animate-spin" />
                  ) : (
                    <Save size={18} />
                  )}
                  {t("maintenance.saveMetadata")}
                </button>
              </form>
            </>
          ) : (
            <div className="flex min-h-[36rem] items-center justify-center rounded-3xl border border-dashed border-white/12 bg-white/[0.035] p-8 text-center">
              <div>
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-white/52">
                  <ImageIcon size={24} />
                </div>

                <h2 className="mt-4 text-xl font-black text-white">
                  {t("maintenance.selectItem")}
                </h2>

                <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-6 text-white/48">
                  {t("maintenance.selectItemDescription")}
                </p>

                <p className="mx-auto mt-4 flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/38">
                  <Sparkles size={14} />
                  {t("maintenance.adminRequired")}
                </p>
              </div>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
