import { FormEvent, useEffect, useMemo, useState } from "react";
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
import type { JellyfinItem, JellyfinLibrary, JellyfinMetadataRefreshMode } from "../lib/types";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import { setPageTitle } from "../lib/pageTitle";

type ActionState = "idle" | "loading" | "success" | "error";

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
      typeof item.CommunityRating === "number" ? String(item.CommunityRating) : "",
    genres: item.Genres?.join(", ") ?? "",
  };
}

function getTypeLabel(item: JellyfinItem) {
  if (item.Type === "Movie") return "Movie";
  if (item.Type === "Episode") return "Episode";
  if (item.Type === "Series") return "Series";
  return item.Type ?? "Item";
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

function formatBoolean(value: boolean | undefined): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return "Unknown";
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return "Unknown";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let nextValue = value;
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  return `${nextValue.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function formatBitrate(value: number | undefined): string {
  if (!value || value <= 0) return "Unknown";
  return `${(value / 1_000_000).toFixed(2)} Mbps`;
}

function formatTicks(value: number | undefined): string {
  if (!value || value <= 0) return "Unknown";

  const totalSeconds = Math.floor(value / 10_000_000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function getDetailValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Unknown";
  if (typeof value === "boolean") return formatBoolean(value);
  if (Array.isArray(value)) return value.length > 0 ? value.join(", ") : "None";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}


function DetailRow({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-3">
      <p className="text-[0.68rem] font-black uppercase tracking-[0.14em] text-white/35">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm font-bold leading-6 text-white/72">
        {getDetailValue(value)}
      </p>
    </div>
  );
}

// Helper to add a timeout to a library load
async function withLibraryLoadTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof window.setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} took too long to load.`));
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
  const [libraries, setLibraries] = useState<JellyfinLibrary[]>([]);
  const [items, setItems] = useState<JellyfinItem[]>([]);
  const [itemLibraryById, setItemLibraryById] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [selectedItem, setSelectedItem] = useState<JellyfinItem | null>(null);
  const [draft, setDraft] = useState<MetadataDraft | null>(null);
  const [trickplayStatus, setTrickplayStatus] = useState<"unknown" | "loading" | "available" | "missing">("unknown");

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

  const [loadState, setLoadState] = useState<ActionResult>(() => createEmptyResult());
  const [scanState, setScanState] = useState<ActionResult>(() => createEmptyResult());
  const [itemRefreshState, setItemRefreshState] = useState<ActionResult>(() =>
    createEmptyResult(),
  );
  const [saveState, setSaveState] = useState<ActionResult>(() => createEmptyResult());

  useEffect(() => {
    setPageTitle("Library Maintenance · Devtools · Seyirlik");
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadInitialData() {
      setLoadState({
        state: "loading",
        message: "Loading Jellyfin libraries and video items...",
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
              result.reason instanceof Error ? result.reason.message : "A library failed to load.",
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
              ? `Loaded ${nextVideoItems.length} video item${nextVideoItems.length === 1 ? "" : "s"}, but ${failedLibraries.length} librar${failedLibraries.length === 1 ? "y" : "ies"} failed: ${failedLibraries.join(" | ")}`
              : `Loaded ${nextVideoItems.length} video item${nextVideoItems.length === 1 ? "" : "s"}.`,
        });
      } catch (error) {
        if (!isMounted) return;

        setLoadState({
          state: "error",
          message: error instanceof Error ? error.message : "Could not load library data.",
        });
      }
    }

    void loadInitialData();

    return () => {
      isMounted = false;
    };
  }, []);


  const visibleItems = useMemo(() => {
    const trimmedSearch = search.trim().toLowerCase();

    return items
      .filter((item) => {
        if (selectedLibraryId !== "all" && itemLibraryById.get(item.Id) !== selectedLibraryId) {
          return false;
        }

        if (selectedEpisodeLibraryId && item.Type !== "Episode") {
          return false;
        }

        if (!selectedEpisodeLibraryId && selectedLibraryId !== "all" && item.Type === "Episode") {
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
  }, [items, selectedLibraryId, selectedEpisodeLibraryId, search, itemLibraryById]);

  const libraryOptions = useMemo(() => {
    const options: Array<{ id: string; label: string }> = [{ id: "all", label: "All libraries" }];

    for (const library of libraries) {
      options.push({
        id: library.Id,
        label: library.Name ?? "Unnamed library",
      });

      if ((library.Name ?? "").toLocaleLowerCase("tr-TR").includes("dizi")) {
        options.push({
          id: `episodes:${library.Id}`,
          label: "Bölümler",
        });
      }
    }

    return options;
  }, [libraries]);

  const selectItem = async (item: JellyfinItem) => {
    setSelectedItem(item);
    setDraft(createDraftFromItem(item));
    setSaveState(createEmptyResult());
    setItemRefreshState(createEmptyResult());
    setTrickplayStatus("loading");

    try {
      const freshItem = await getItem(item.Id);
      setSelectedItem(freshItem);
      setDraft(createDraftFromItem(freshItem));
    } catch {
      // Keep the existing loaded item if the detail refresh fails.
    }
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
      message: "Starting full Jellyfin library scan...",
    });

    try {
      await scanAllLibraries();
      setScanState({
        state: "success",
        message: "Full library scan started.",
      });
    } catch (error) {
      setScanState({
        state: "error",
        message: error instanceof Error ? error.message : "Could not start library scan.",
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
      message: "Starting selected library scan...",
    });

    try {
      await refreshLibraryMetadata(selectedLibraryId);
      setScanState({
        state: "success",
        message: "Selected library scan started.",
      });
    } catch (error) {
      setScanState({
        state: "error",
        message: error instanceof Error ? error.message : "Could not scan selected library.",
      });
    }
  };

  const handleRefreshSelectedItem = async () => {
    if (!selectedItem) return;

    setItemRefreshState({
      state: "loading",
      message: "Refreshing selected item metadata...",
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

      setItemRefreshState({
        state: "success",
        message: "Metadata refresh started for this item.",
      });
    } catch (error) {
      setItemRefreshState({
        state: "error",
        message: error instanceof Error ? error.message : "Could not refresh item metadata.",
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
        message: "Name cannot be empty.",
      });
      return;
    }

    setSaveState({
      state: "loading",
      message: "Saving metadata...",
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
      setItems((currentItems) =>
        currentItems.map((item) => (item.Id === refreshed.Id ? refreshed : item)),
      );

      setSaveState({
        state: "success",
        message: "Metadata saved.",
      });
    } catch (error) {
      setSaveState({
        state: "error",
        message: error instanceof Error ? error.message : "Could not save metadata.",
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
            Back to Devtools
          </Link>

          <div className="relative mt-6 grid gap-5 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
                Jellyfin Maintenance
              </p>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
                  <DatabaseZap size={23} />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-white sm:text-4xl">
                    Library Scan & Metadata
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-white/52">
                    Scan Jellyfin libraries, refresh item metadata, replace images, and edit common item fields.
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
              Scan all libraries
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
                Library Items
              </p>
              <h2 className="mt-2 text-xl font-black text-white">
                {visibleItems.length} visible item{visibleItems.length === 1 ? "" : "s"}
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
              Scan selected
            </button>
          </div>

          <div className="mt-5 grid gap-4">
            <div className="block">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                Library
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
                Search
              </span>
              <div className="relative mt-2">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/30"
                />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search movie, episode, series..."
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
                        {getTypeLabel(item)}
                      </p>

                      <h3 className="mt-3 truncate text-base font-black text-white">
                        {getDisplayTitle(item)}
                      </h3>

                      <p className="mt-1 line-clamp-2 text-sm font-medium leading-6 text-white/50">
                        {getItemSubtitle(item) || item.Overview || "No subtitle available."}
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
                    Metadata Editor
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
                  Refresh metadata
                </button>
              </div>

              <div className="mt-5 grid gap-3 rounded-3xl border border-white/10 bg-white/[0.04] p-4 sm:grid-cols-3">
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    Metadata mode
                  </span>
                  <select
                    value={metadataRefreshMode}
                    onChange={(event) =>
                      setMetadataRefreshMode(event.target.value as JellyfinMetadataRefreshMode)
                    }
                    className="mt-2 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 py-3 text-sm font-bold text-white outline-none transition focus:border-[var(--accent)]/50"
                  >
                    <option value="Default">Default</option>
                    <option value="FullRefresh">Full refresh</option>
                    <option value="None">None</option>
                  </select>
                </label>

                <label className="flex items-end gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <input
                    type="checkbox"
                    checked={replaceAllMetadata}
                    onChange={(event) => setReplaceAllMetadata(event.target.checked)}
                    className="h-5 w-5 accent-[var(--accent)]"
                  />
                  <span className="text-sm font-black text-white/72">
                    Replace metadata
                  </span>
                </label>

                <label className="flex items-end gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <input
                    type="checkbox"
                    checked={replaceAllImages}
                    onChange={(event) => setReplaceAllImages(event.target.checked)}
                    className="h-5 w-5 accent-[var(--accent)]"
                  />
                  <span className="text-sm font-black text-white/72">
                    Replace images
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

              <section className="mt-5 space-y-4 rounded-3xl border border-white/10 bg-white/[0.035] p-4">
                <div>
                  <p className="text-sm font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                    Display metadata preview
                  </p>
                  <h3 className="mt-2 text-lg font-black text-white">
                    Images, trickplay, media source, and raw identifiers
                  </h3>
                  <p className="mt-1 text-sm font-semibold leading-6 text-white/45">
                    This section is read-only. It shows what Jellyfin currently exposes for this item.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-[2/3] bg-white/[0.04]">
                      <img
                        src={getPrimaryImageUrl(selectedItem.Id, selectedItem.ImageTags?.Primary, 600)}
                        alt={`${getDisplayTitle(selectedItem)} primary poster`}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <p className="px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/45">
                      Primary poster
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-video bg-white/[0.04]">
                      {selectedItem.BackdropImageTags?.[0] ? (
                        <img
                          src={getBackdropImageUrl(selectedItem.Id, selectedItem.BackdropImageTags[0], 900)}
                          alt={`${getDisplayTitle(selectedItem)} backdrop`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm font-bold text-white/35">
                          No backdrop
                        </div>
                      )}
                    </div>
                    <p className="px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/45">
                      Backdrop / banner
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-video bg-white/[0.04] p-4">
                      {selectedItem.ImageTags?.Logo || selectedItem.ParentLogoImageTag ? (
                        <img
                          src={getLogoImageUrl(
                            selectedItem.ImageTags?.Logo ? selectedItem.Id : (selectedItem.ParentLogoItemId ?? selectedItem.Id),
                            selectedItem.ImageTags?.Logo ?? selectedItem.ParentLogoImageTag,
                            900,
                          )}
                          alt={`${getDisplayTitle(selectedItem)} logo`}
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm font-bold text-white/35">
                          No logo
                        </div>
                      )}
                    </div>
                    <p className="px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/45">
                      Logo
                    </p>
                  </div>

                  <div className="overflow-hidden rounded-2xl border border-white/10 bg-black/30">
                    <div className="aspect-video bg-white/[0.04]">
                      {selectedItem.MediaSources?.[0]?.Id ? (
                        <img
                          src={getTrickplayImageUrl(selectedItem.Id, selectedItem.MediaSources[0].Id, 320, 0)}
                          alt={`${getDisplayTitle(selectedItem)} trickplay sample`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-sm font-bold text-white/35">
                          No media source
                        </div>
                      )}
                    </div>
                    <div className="px-3 py-2">
                      <p className="text-xs font-black uppercase tracking-[0.12em] text-white/45">
                        Trickplay sample
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
                          ? "Created / available"
                          : trickplayStatus === "missing"
                            ? "Not created or unavailable"
                            : "Checking..."}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <DetailRow label="Item ID" value={selectedItem.Id} />
                  <DetailRow label="Type" value={selectedItem.Type} />
                  <DetailRow label="Media type" value={selectedItem.MediaType} />
                  <DetailRow label="Sort name" value={selectedItem.SortName} />
                  <DetailRow label="Production year" value={selectedItem.ProductionYear} />
                  <DetailRow label="Official rating" value={selectedItem.OfficialRating} />
                  <DetailRow label="Community rating" value={selectedItem.CommunityRating} />
                  <DetailRow label="Runtime" value={formatTicks(selectedItem.RunTimeTicks)} />
                  <DetailRow label="Genres" value={selectedItem.Genres} />
                  <DetailRow label="Primary image tag" value={selectedItem.ImageTags?.Primary} />
                  <DetailRow label="Logo image tag" value={selectedItem.ImageTags?.Logo ?? selectedItem.ParentLogoImageTag} />
                  <DetailRow label="Backdrop image tags" value={selectedItem.BackdropImageTags} />
                  <DetailRow label="Parent ID" value={selectedItem.ParentId} />
                  <DetailRow label="Series ID" value={selectedItem.SeriesId} />
                  <DetailRow label="Season ID" value={selectedItem.SeasonId} />
                  <DetailRow label="User played" value={selectedItem.UserData?.Played} />
                  <DetailRow label="Playback position" value={formatTicks(selectedItem.UserData?.PlaybackPositionTicks)} />
                  <DetailRow label="Chapters" value={selectedItem.Chapters?.length ? `${selectedItem.Chapters.length} chapter(s)` : "None"} />
                </div>

                {selectedItem.MediaSources?.[0] ? (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    <DetailRow label="Media source ID" value={selectedItem.MediaSources[0].Id} />
                    <DetailRow label="Path" value={selectedItem.MediaSources[0].Path} />
                    <DetailRow label="Container" value={selectedItem.MediaSources[0].Container} />
                    <DetailRow label="Size" value={formatBytes(selectedItem.MediaSources[0].Size)} />
                    <DetailRow label="Bitrate" value={formatBitrate(selectedItem.MediaSources[0].Bitrate)} />
                    <DetailRow label="Direct play" value={selectedItem.MediaSources[0].SupportsDirectPlay} />
                    <DetailRow label="Direct stream" value={selectedItem.MediaSources[0].SupportsDirectStream} />
                    <DetailRow label="Transcoding" value={selectedItem.MediaSources[0].SupportsTranscoding} />
                    <DetailRow label="Default audio index" value={selectedItem.MediaSources[0].DefaultAudioStreamIndex} />
                    <DetailRow label="Default subtitle index" value={selectedItem.MediaSources[0].DefaultSubtitleStreamIndex} />
                  </div>
                ) : null}

                {selectedItem.MediaSources?.[0]?.MediaStreams?.length ? (
                  <div className="space-y-3">
                    <p className="text-sm font-black uppercase tracking-[0.18em] text-white/38">
                      Media streams
                    </p>

                    {selectedItem.MediaSources[0].MediaStreams.map((stream) => (
                      <div
                        key={`${stream.Type}-${stream.Index}`}
                        className="rounded-2xl border border-white/10 bg-black/25 p-4"
                      >
                        <p className="text-sm font-black text-white">
                          {stream.Type ?? "Stream"} {stream.Index !== undefined ? `#${stream.Index}` : ""}
                        </p>
                        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                          <DetailRow label="Codec" value={stream.Codec} />
                          <DetailRow label="Profile" value={stream.Profile} />
                          <DetailRow label="Language" value={stream.Language} />
                          <DetailRow label="Display title" value={stream.DisplayTitle} />
                          <DetailRow label="Default" value={stream.IsDefault} />
                          <DetailRow label="Forced" value={stream.IsForced} />
                          <DetailRow label="External" value={stream.IsExternal} />
                          <DetailRow label="Channels" value={stream.Channels} />
                          <DetailRow label="Bitrate" value={formatBitrate(stream.BitRate)} />
                          <DetailRow label="Resolution" value={stream.Width && stream.Height ? `${stream.Width}×${stream.Height}` : "Unknown"} />
                          <DetailRow label="Frame rate" value={stream.AverageFrameRate ?? stream.RealFrameRate} />
                          <DetailRow label="Video range" value={stream.VideoRangeType ?? stream.VideoRange} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </section>

              <form onSubmit={handleSaveMetadata} className="mt-5 space-y-4">
                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    Name
                  </span>
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, name: event.target.value } : current,
                      )
                    }
                    className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    Sort name
                  </span>
                  <input
                    value={draft.sortName}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, sortName: event.target.value } : current,
                      )
                    }
                    className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                  />
                </label>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    Overview
                  </span>
                  <textarea
                    value={draft.overview}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, overview: event.target.value } : current,
                      )
                    }
                    rows={8}
                    className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold leading-6 text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                      Year
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
                      Rating
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
                      placeholder="R, PG-13..."
                      className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                    />
                  </label>

                  <label className="block">
                    <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                      Community rating
                    </span>
                    <input
                      value={draft.communityRating}
                      onChange={(event) =>
                        setDraft((current) =>
                          current
                            ? { ...current, communityRating: event.target.value }
                            : current,
                        )
                      }
                      placeholder="8.5"
                      className="mt-2 w-full rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-semibold text-white outline-none transition placeholder:text-white/26 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
                    />
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
                    Genres
                  </span>
                  <input
                    value={draft.genres}
                    onChange={(event) =>
                      setDraft((current) =>
                        current ? { ...current, genres: event.target.value } : current,
                      )
                    }
                    placeholder="Crime, Drama, Thriller"
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
                  Save metadata
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
                  Select an item
                </h2>

                <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-6 text-white/48">
                  Choose a movie or episode from the left side to refresh its Jellyfin metadata or edit common fields.
                </p>

                <p className="mx-auto mt-4 flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white/38">
                  <Sparkles size={14} />
                  Admin permissions may be required
                </p>
              </div>
            </div>
          )}
        </section>
      </section>
    </div>
  );
}