import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileJson,
  FileSpreadsheet,
  Film,
  Grid2X2,
  Search,
  Tv,
  Video,
} from "lucide-react";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { getAllContentItems, getPrimaryImageUrl } from "../lib/jellyfinApi";
import { formatRuntime, getDisplayTitle, getItemSubtitle } from "../lib/format";
import { getRouteForItem } from "../lib/routes";
import { setPageTitle } from "../lib/pageTitle";
import type { JellyfinItem } from "../lib/types";

type ContentFilter =
  | "all"
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "video"
  | "folder"
  | "other";

function getContentBucket(item: JellyfinItem): ContentFilter {
  if (item.Type === "Movie") return "movie";
  if (item.Type === "Series") return "series";
  if (item.Type === "Season") return "season";
  if (item.Type === "Episode") return "episode";
  if (item.MediaType === "Video") return "video";
  if (item.Type === "Folder" || item.CollectionType) return "folder";
  return "other";
}

function getContentTypeLabel(item: JellyfinItem): string {
  if (item.CollectionType) return `Library · ${item.CollectionType}`;
  if (item.Type) return item.Type;
  if (item.MediaType) return item.MediaType;
  return "Unknown";
}

function getContentIcon(item: JellyfinItem) {
  if (item.Type === "Movie") return Film;
  if (item.Type === "Series") return Tv;
  if (item.Type === "Episode") return Video;
  return Grid2X2;
}

function getYearLabel(item: JellyfinItem): string {
  return item.ProductionYear ? String(item.ProductionYear) : "—";
}

function getRuntimeLabel(item: JellyfinItem): string {
  return formatRuntime(item.RunTimeTicks) ?? "—";
}

function getPlayableRoute(item: JellyfinItem): string | null {
  const canPlay =
    item.Type === "Movie" ||
    item.Type === "Episode" ||
    item.MediaType === "Video";
  return canPlay ? `/watch/${item.Id}` : null;
}

function copyText(value: string) {
  void navigator.clipboard?.writeText(value).catch(() => {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  });
}

function sanitizeForFilename(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function downloadTextFile(filename: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const stringValue =
    typeof value === "object" ? JSON.stringify(value) : String(value);

  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function buildCsv(items: JellyfinItem[]): string {
  const headers = [
    "Id",
    "Name",
    "SortName",
    "Type",
    "MediaType",
    "CollectionType",
    "ProductionYear",
    "RunTimeTicks",
    "Runtime",
    "SeriesName",
    "SeasonName",
    "ParentId",
    "SeriesId",
    "SeasonId",
    "IndexNumber",
    "ParentIndexNumber",
    "Overview",
    "Genres",
    "OfficialRating",
    "CommunityRating",
    "DateCreated",
    "PremiereDate",
    "Played",
    "PlayedPercentage",
    "PlayCount",
    "HasPrimaryImage",
    "HasBackdrop",
    "MediaSources",
    "MediaStreams",
  ];

  const rows = items.map((item) => {
    const mediaSources = item.MediaSources ?? [];
    const mediaStreams = mediaSources.flatMap(
      (source) => source.MediaStreams ?? [],
    );

    return [
      item.Id,
      item.Name,
      item.SortName,
      item.Type,
      item.MediaType,
      item.CollectionType,
      item.ProductionYear,
      item.RunTimeTicks,
      formatRuntime(item.RunTimeTicks),
      item.SeriesName,
      item.SeasonName,
      item.ParentId,
      item.SeriesId,
      item.SeasonId,
      item.IndexNumber,
      item.ParentIndexNumber,
      item.Overview,
      item.Genres?.join("|"),
      item.OfficialRating,
      item.CommunityRating,
      item.DateCreated,
      item.PremiereDate,
      item.UserData?.Played,
      item.UserData?.PlayedPercentage,
      item.UserData?.PlayCount,
      Boolean(item.ImageTags?.Primary),
      Boolean(item.BackdropImageTags?.length),
      mediaSources,
      mediaStreams,
    ];
  });

  return [
    headers.map(escapeCsvValue).join(","),
    ...rows.map((row) => row.map(escapeCsvValue).join(",")),
  ].join("\n");
}

function buildAiFriendlyJson(items: JellyfinItem[]) {
  return {
    exportedAt: new Date().toISOString(),
    source: "Seyirlik Content Explorer",
    itemCount: items.length,
    summary: {
      movies: items.filter((item) => item.Type === "Movie").length,
      series: items.filter((item) => item.Type === "Series").length,
      seasons: items.filter((item) => item.Type === "Season").length,
      episodes: items.filter((item) => item.Type === "Episode").length,
      videos: items.filter((item) => item.MediaType === "Video").length,
    },
    items: items.map((item) => ({
      id: item.Id,
      name: item.Name,
      displayTitle: getDisplayTitle(item),
      sortName: item.SortName,
      type: item.Type,
      mediaType: item.MediaType,
      collectionType: item.CollectionType,
      productionYear: item.ProductionYear,
      runtime: formatRuntime(item.RunTimeTicks),
      runtimeTicks: item.RunTimeTicks,
      overview: item.Overview,
      genres: item.Genres,
      officialRating: item.OfficialRating,
      communityRating: item.CommunityRating,
      dateCreated: item.DateCreated,
      premiereDate: item.PremiereDate,
      seriesName: item.SeriesName,
      seasonName: item.SeasonName,
      parentId: item.ParentId,
      seriesId: item.SeriesId,
      seasonId: item.SeasonId,
      indexNumber: item.IndexNumber,
      parentIndexNumber: item.ParentIndexNumber,
      childCount: item.ChildCount,
      recursiveItemCount: item.RecursiveItemCount,
      userData: item.UserData,
      images: {
        hasPrimary: Boolean(item.ImageTags?.Primary),
        hasLogo: Boolean(item.ImageTags?.Logo),
        hasBackdrop: Boolean(item.BackdropImageTags?.length),
        imageTags: item.ImageTags,
        backdropImageTags: item.BackdropImageTags,
        parentLogoItemId: item.ParentLogoItemId,
        parentLogoImageTag: item.ParentLogoImageTag,
      },
      mediaSources: item.MediaSources?.map((source) => ({
        id: source.Id,
        name: source.Name,
        path: source.Path,
        protocol: source.Protocol,
        type: source.Type,
        container: source.Container,
        size: source.Size,
        bitrate: source.Bitrate,
        runtimeTicks: source.RunTimeTicks,
        supportsDirectPlay: source.SupportsDirectPlay,
        supportsDirectStream: source.SupportsDirectStream,
        supportsTranscoding: source.SupportsTranscoding,
        defaultAudioStreamIndex: source.DefaultAudioStreamIndex,
        defaultSubtitleStreamIndex: source.DefaultSubtitleStreamIndex,
        transcodingContainer: source.TranscodingContainer,
        transcodingSubProtocol: source.TranscodingSubProtocol,
        transcodingReasons: source.TranscodingReasons,
        directPlayError: source.DirectPlayError,
        mediaStreams: source.MediaStreams?.map((stream) => ({
          index: stream.Index,
          type: stream.Type,
          codec: stream.Codec,
          profile: stream.Profile,
          level: stream.Level,
          language: stream.Language,
          displayTitle: stream.DisplayTitle,
          title: stream.Title,
          isDefault: stream.IsDefault,
          isForced: stream.IsForced,
          isExternal: stream.IsExternal,
          channels: stream.Channels,
          bitrate: stream.BitRate,
          width: stream.Width,
          height: stream.Height,
          averageFrameRate: stream.AverageFrameRate,
          realFrameRate: stream.RealFrameRate,
          videoRange: stream.VideoRange,
          videoRangeType: stream.VideoRangeType,
          colorTransfer: stream.ColorTransfer,
          colorPrimaries: stream.ColorPrimaries,
          colorSpace: stream.ColorSpace,
        })),
      })),
    })),
  };
}

export function ContentExplorerPage() {
  const [items, setItems] = useState<JellyfinItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeFilter, setActiveFilter] = useState<ContentFilter>("all");

  useEffect(() => {
    setPageTitle("Content Explorer · Devtools · Seyirlik");
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadContent() {
      setIsLoading(true);
      setError(null);

      try {
        const result = await getAllContentItems();

        if (isMounted) {
          setItems(result);
        }
      } catch (loadError) {
        if (isMounted) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load content items.",
          );
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadContent();

    return () => {
      isMounted = false;
    };
  }, []);

  const stats = useMemo(() => {
    return {
      total: items.length,
      movies: items.filter((item) => item.Type === "Movie").length,
      series: items.filter((item) => item.Type === "Series").length,
      seasons: items.filter((item) => item.Type === "Season").length,
      episodes: items.filter((item) => item.Type === "Episode").length,
      videos: items.filter((item) => item.MediaType === "Video").length,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return items
      .filter((item) => {
        if (activeFilter !== "all" && getContentBucket(item) !== activeFilter) {
          return false;
        }

        if (!normalizedSearch) {
          return true;
        }

        const searchableText = [
          item.Name,
          item.SortName,
          item.Type,
          item.MediaType,
          item.CollectionType,
          item.SeriesName,
          item.SeasonName,
          item.ProductionYear,
          item.Id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return searchableText.includes(normalizedSearch);
      })
      .sort((left, right) =>
        (left.SortName ?? left.Name).localeCompare(
          right.SortName ?? right.Name,
          undefined,
          {
            numeric: true,
          },
        ),
      );
  }, [activeFilter, items, searchTerm]);

  const exportSuffix = sanitizeForFilename(
    activeFilter === "all" ? "all-content" : `${activeFilter}-content`,
  );

  const handleExportJson = () => {
    const payload = buildAiFriendlyJson(filteredItems);

    downloadTextFile(
      `seyirlik-${exportSuffix}-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      "application/json;charset=utf-8",
    );
  };

  const handleExportCsv = () => {
    downloadTextFile(
      `seyirlik-${exportSuffix}-${new Date().toISOString().slice(0, 10)}.csv`,
      buildCsv(filteredItems),
      "text/csv;charset=utf-8",
    );
  };

  const filterOptions: Array<{ id: ContentFilter; label: string }> = [
    { id: "all", label: "All" },
    { id: "movie", label: "Movies" },
    { id: "series", label: "Series" },
    { id: "season", label: "Seasons" },
    { id: "episode", label: "Episodes" },
    { id: "video", label: "Other videos" },
    { id: "folder", label: "Folders / libraries" },
    { id: "other", label: "Other" },
  ];

  if (error) {
    return (
      <ErrorMessage title="Content Explorer unavailable" message={error} />
    );
  }

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
                Jellyfin Inventory
              </p>

              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[var(--accent)]/10 text-[var(--accent)]">
                  <Database size={23} />
                </div>

                <div>
                  <h1 className="text-3xl font-black text-white sm:text-4xl">
                    Content Explorer
                  </h1>
                  <p className="mt-1 max-w-2xl text-sm font-semibold leading-6 text-white/52">
                    Lists every item Jellyfin returns for this user, including
                    movies, series, seasons, episodes, folders, libraries, and
                    unknown item types.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 rounded-3xl border border-white/10 bg-black/25 p-2 sm:grid-cols-6">
              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">{stats.total}</p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  Total
                </p>
              </div>

              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">{stats.movies}</p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  Movies
                </p>
              </div>

              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">{stats.series}</p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  Series
                </p>
              </div>

              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">{stats.seasons}</p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  Seasons
                </p>
              </div>

              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">
                  {stats.episodes}
                </p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  Episodes
                </p>
              </div>

              <div className="rounded-2xl bg-white/[0.06] px-3 py-2 text-center">
                <p className="text-lg font-black text-white">{stats.videos}</p>
                <p className="text-[0.68rem] font-bold uppercase tracking-wide text-white/42">
                  Videos
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-white/10 bg-black/30 p-4 shadow-2xl backdrop-blur-xl sm:p-5">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <label className="relative">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-white/42">
              Search content
            </span>

            <Search
              className="pointer-events-none absolute bottom-3.5 left-4 text-white/38"
              size={19}
            />

            <input
              type="search"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search title, type, series, year, or item ID..."
              className="mt-2 min-h-12 w-full rounded-2xl border border-white/10 bg-white/[0.06] py-3 pl-11 pr-4 text-sm font-semibold text-white outline-none transition placeholder:text-white/28 focus:border-[var(--accent)]/50 focus:bg-white/[0.085]"
            />
          </label>

          <div className="flex flex-wrap gap-2">
            {filterOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setActiveFilter(option.id)}
                className={`rounded-full border px-3 py-2 text-xs font-black uppercase tracking-[0.1em] transition ${
                  activeFilter === option.id
                    ? "border-[var(--accent)]/45 bg-[var(--accent)] text-black"
                    : "border-white/10 bg-white/[0.055] text-white/50 hover:border-white/20 hover:text-white"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 lg:col-span-2">
            <button
              type="button"
              onClick={handleExportJson}
              disabled={filteredItems.length === 0}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-[var(--accent)] px-4 py-3 text-sm font-black text-black shadow-[0_16px_40px_var(--accent-soft)] transition hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              <FileJson size={17} />
              Export JSON
            </button>

            <button
              type="button"
              onClick={handleExportCsv}
              disabled={filteredItems.length === 0}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/[0.06] px-4 py-3 text-sm font-black text-white/72 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              <FileSpreadsheet size={17} />
              Export CSV
            </button>

            <div className="flex min-h-11 items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-xs font-bold leading-5 text-white/42">
              <Download size={15} />
              Exports current search/filter only · {filteredItems.length} item
              {filteredItems.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        {isLoading ? (
          <LoadingSpinner label="Loading all content..." />
        ) : filteredItems.length > 0 ? (
          <div className="mt-5 overflow-hidden rounded-3xl border border-white/10">
            <div className="max-h-[68vh] overflow-auto">
              <table className="w-full min-w-[980px] border-separate border-spacing-0 text-left">
                <thead className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur-xl">
                  <tr className="text-xs font-black uppercase tracking-[0.14em] text-white/42">
                    <th className="border-b border-white/10 px-4 py-3">Item</th>
                    <th className="border-b border-white/10 px-4 py-3">Type</th>
                    <th className="border-b border-white/10 px-4 py-3">Year</th>
                    <th className="border-b border-white/10 px-4 py-3">
                      Runtime
                    </th>
                    <th className="border-b border-white/10 px-4 py-3">
                      Parent
                    </th>
                    <th className="border-b border-white/10 px-4 py-3">ID</th>
                    <th className="border-b border-white/10 px-4 py-3 text-right">
                      Actions
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {filteredItems.map((item) => {
                    const Icon = getContentIcon(item);
                    const title = getDisplayTitle(item);
                    const subtitle = getItemSubtitle(item);
                    const imageUrl = item.ImageTags?.Primary
                      ? getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 160)
                      : "";
                    const detailsRoute = getRouteForItem(item);
                    const watchRoute = getPlayableRoute(item);

                    return (
                      <tr
                        key={item.Id}
                        className="group border-b border-white/10 bg-white/[0.025] transition hover:bg-white/[0.06]"
                      >
                        <td className="border-b border-white/10 px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white/[0.06]">
                              {imageUrl ? (
                                <img
                                  src={imageUrl}
                                  alt=""
                                  loading="lazy"
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <Icon size={18} className="text-white/45" />
                              )}
                            </div>

                            <div className="min-w-0">
                              <Link
                                to={detailsRoute}
                                className="block truncate text-sm font-black text-white transition hover:text-[var(--accent)]"
                              >
                                {title}
                              </Link>

                              <p className="mt-1 max-w-md truncate text-xs font-semibold text-white/42">
                                {subtitle ?? item.Overview ?? "No subtitle"}
                              </p>
                            </div>
                          </div>
                        </td>

                        <td className="border-b border-white/10 px-4 py-3">
                          <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-xs font-black text-white/62">
                            {getContentTypeLabel(item)}
                          </span>
                        </td>

                        <td className="border-b border-white/10 px-4 py-3 text-sm font-bold text-white/60">
                          {getYearLabel(item)}
                        </td>

                        <td className="border-b border-white/10 px-4 py-3 text-sm font-bold text-white/60">
                          {getRuntimeLabel(item)}
                        </td>

                        <td className="border-b border-white/10 px-4 py-3 text-sm font-semibold text-white/48">
                          <div className="max-w-[14rem] truncate">
                            {item.SeriesName ??
                              item.SeasonName ??
                              item.ParentId ??
                              "—"}
                          </div>
                        </td>

                        <td className="border-b border-white/10 px-4 py-3">
                          <button
                            type="button"
                            onClick={() => copyText(item.Id)}
                            className="max-w-[11rem] truncate rounded-lg border border-white/10 bg-black/25 px-2 py-1 font-mono text-xs text-white/42 transition hover:border-[var(--accent)]/35 hover:text-[var(--accent)]"
                            title="Copy item ID"
                          >
                            {item.Id}
                          </button>
                        </td>

                        <td className="border-b border-white/10 px-4 py-3">
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                copyText(JSON.stringify(item, null, 2))
                              }
                              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/50 transition hover:border-emerald-400/35 hover:text-emerald-200"
                              title="Copy raw JSON"
                            >
                              <Copy size={16} />
                            </button>

                            <Link
                              to={detailsRoute}
                              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white/50 transition hover:border-[var(--accent)]/35 hover:text-[var(--accent)]"
                              title="Open details"
                            >
                              <ExternalLink size={16} />
                            </Link>

                            {watchRoute ? (
                              <Link
                                to={watchRoute}
                                className="inline-flex h-9 items-center justify-center rounded-full bg-[var(--accent)] px-3 text-xs font-black text-black transition hover:bg-[var(--accent-hover)]"
                              >
                                Play
                              </Link>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-3xl border border-dashed border-white/12 bg-white/[0.035] p-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-white/52">
              <Database size={22} />
            </div>

            <h3 className="mt-4 text-lg font-black text-white">
              No content matched
            </h3>
            <p className="mx-auto mt-2 max-w-md text-sm font-medium leading-6 text-white/48">
              Try clearing the search or switching the filter back to All.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
