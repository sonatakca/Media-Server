import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Film,
  Languages,
  Loader2,
  Save,
  Search,
  Subtitles,
  Volume2,
} from "lucide-react";
import { Button } from "../components/Button";
import { ErrorMessage } from "../components/ErrorMessage";
import { LoadingSpinner } from "../components/LoadingSpinner";
import { getDisplayTitle, getItemSubtitle } from "../lib/format";
import {
  getAllMovieAndSeriesItems,
  getAllSeriesEpisodes,
  getBackdropImageUrl,
  getItem,
  getPrimaryImageUrl,
  updateItemMetadata,
} from "../lib/jellyfinApi";
import {
  buildItemWithPlaybackDefaults,
  getDefaultAudioStreamIndexForItem,
  getDefaultSubtitleStreamIndexForItem,
} from "../lib/playbackDefaults";
import { setPageTitle } from "../lib/pageTitle";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import type { JellyfinItem, JellyfinMediaStream } from "../lib/types";

type ActionState = "idle" | "loading" | "success" | "error";
type Translate = (key: TranslationKey) => string;

interface ActionResult {
  state: ActionState;
  message: string;
}

interface SaveResult {
  itemId: string;
  title: string;
  status: "success" | "failed";
  message?: string;
}

interface StreamDefaultOption {
  index: number;
  stream: JellyfinMediaStream;
  itemCount: number;
}

const MIXED_STREAM_INDEX = -2;
const NO_AUDIO_STREAM_INDEX = -3;

function createEmptyResult(): ActionResult {
  return {
    state: "idle",
    message: "",
  };
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

function getItemArtworkUrl(item: JellyfinItem): string {
  if (item.ImageTags?.Primary) {
    return getPrimaryImageUrl(item.Id, item.ImageTags.Primary, 360);
  }

  if (item.BackdropImageTags?.[0]) {
    return getBackdropImageUrl(item.Id, item.BackdropImageTags[0], 520);
  }

  if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.[0]) {
    return getBackdropImageUrl(
      item.ParentBackdropItemId,
      item.ParentBackdropImageTags[0],
      520,
    );
  }

  return "";
}

function getItemTypeLabel(item: JellyfinItem, t: Translate): string {
  if (item.Type === "Movie") return t("common.movie");
  if (item.Type === "Series") return t("common.series");
  return item.Type ?? t("common.item");
}

function itemMatchesQuery(
  item: JellyfinItem,
  query: string,
  t: Translate,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return true;
  }

  const searchableText = [
    getDisplayTitle(item),
    item.Name,
    item.SortName,
    item.ProductionYear?.toString(),
    getItemTypeLabel(item, t),
    item.Id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();

  return searchableText.includes(normalizedQuery);
}

function getStreamsOfType(
  item: JellyfinItem,
  type: "Audio" | "Subtitle",
): JellyfinMediaStream[] {
  return (
    item.MediaSources?.[0]?.MediaStreams?.filter(
      (stream) => stream.Type?.toLowerCase() === type.toLowerCase(),
    ) ?? []
  );
}

function getStreamOptions(
  items: JellyfinItem[],
  type: "Audio" | "Subtitle",
): StreamDefaultOption[] {
  const optionsByIndex = new Map<number, StreamDefaultOption>();

  items.forEach((item) => {
    const seenIndexes = new Set<number>();

    getStreamsOfType(item, type).forEach((stream) => {
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

function getCommonDefaultIndex(
  items: JellyfinItem[],
  getDefaultIndex: (item: JellyfinItem) => number | undefined,
): number | undefined {
  if (items.length === 0) return undefined;

  const firstDefault = getDefaultIndex(items[0]);

  return items.every((item) => getDefaultIndex(item) === firstDefault)
    ? firstDefault
    : MIXED_STREAM_INDEX;
}

function getStreamLabel(
  stream: JellyfinMediaStream,
  fallback: string,
  t: Translate,
): string {
  const prefix = stream.Index !== undefined ? `#${stream.Index}` : fallback;
  const details = [
    stream.DisplayTitle,
    stream.Title,
    stream.Language?.toUpperCase(),
    stream.Codec?.toUpperCase(),
    stream.Channels
      ? t("details.audioChannelsShort").replace(
          "{count}",
          String(stream.Channels),
        )
      : undefined,
    stream.IsDefault ? t("stream.default") : undefined,
    stream.IsForced ? t("stream.forced") : undefined,
    stream.IsExternal ? t("stream.external") : undefined,
  ].filter(Boolean);

  const uniqueDetails = Array.from(new Set(details));
  return uniqueDetails.length > 0
    ? `${prefix} · ${uniqueDetails.join(" · ")}`
    : prefix;
}

function getOptionCountLabel(
  option: StreamDefaultOption,
  totalItems: number,
  selectedItem: JellyfinItem | null,
  t: Translate,
): string | null {
  if (!selectedItem || selectedItem.Type !== "Series" || totalItems <= 1) {
    return null;
  }

  return formatTemplate(
    t(option.itemCount === 1 ? "media.episodeSingular" : "media.episodePlural"),
    { count: option.itemCount },
  );
}

function formatSelectedStreamIndex(
  value: number,
  streamKind: "audio" | "subtitle",
  t: Translate,
): string {
  if (value === MIXED_STREAM_INDEX) {
    return t("playbackDefaults.mixed");
  }

  if (streamKind === "audio" && value === NO_AUDIO_STREAM_INDEX) {
    return t("playbackDefaults.noAudioStreams");
  }

  if (streamKind === "subtitle" && value === -1) {
    return t("playbackDefaults.subtitlesOff");
  }

  return `#${value}`;
}

export function PlaybackDefaultsPage() {
  const { t } = useLanguage();
  const loadTargetsRequestIdRef = useRef(0);
  const [items, setItems] = useState<JellyfinItem[] | null>(null);
  const [selectedItem, setSelectedItem] = useState<JellyfinItem | null>(null);
  const [targetItems, setTargetItems] = useState<JellyfinItem[]>([]);
  const [selectedAudioStreamIndex, setSelectedAudioStreamIndex] =
    useState<number>(NO_AUDIO_STREAM_INDEX);
  const [selectedSubtitleStreamIndex, setSelectedSubtitleStreamIndex] =
    useState<number>(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [saveState, setSaveState] = useState<ActionResult>(createEmptyResult);
  const [saveResults, setSaveResults] = useState<SaveResult[]>([]);

  useEffect(() => {
    setPageTitle(`${t("playbackDefaults.title")} · Seyirlik`, {
      canonicalPath: "/dev/playback-defaults",
      robots: "noindex, nofollow",
    });
  }, [t]);

  useEffect(() => {
    let isMounted = true;

    async function loadItems() {
      setError(null);

      try {
        const nextItems = await getAllMovieAndSeriesItems();

        if (!isMounted) {
          return;
        }

        setItems(nextItems);
      } catch (loadError) {
        if (!isMounted) {
          return;
        }

        setError(
          loadError instanceof Error
            ? loadError.message
            : t("playbackDefaults.loadFailed"),
        );
      }
    }

    void loadItems();

    return () => {
      isMounted = false;
    };
  }, [t]);

  const filteredItems = useMemo(
    () =>
      (items ?? []).filter((item) => itemMatchesQuery(item, searchQuery, t)),
    [items, searchQuery, t],
  );

  const audioOptions = useMemo(
    () => getStreamOptions(targetItems, "Audio"),
    [targetItems],
  );
  const subtitleOptions = useMemo(
    () => getStreamOptions(targetItems, "Subtitle"),
    [targetItems],
  );
  const successfulResultCount = saveResults.filter(
    (result) => result.status === "success",
  ).length;
  const failedResultCount = saveResults.filter(
    (result) => result.status === "failed",
  ).length;
  const hasSelectedAudioOption = audioOptions.some(
    (option) => option.index === selectedAudioStreamIndex,
  );
  const hasSelectedSubtitleOption =
    selectedSubtitleStreamIndex === -1 ||
    subtitleOptions.some(
      (option) => option.index === selectedSubtitleStreamIndex,
    );
  const canSave =
    Boolean(selectedItem) &&
    targetItems.length > 0 &&
    hasSelectedAudioOption &&
    hasSelectedSubtitleOption &&
    selectedAudioStreamIndex !== MIXED_STREAM_INDEX &&
    selectedSubtitleStreamIndex !== MIXED_STREAM_INDEX &&
    saveState.state !== "loading";
  const selectedItemArtworkUrl = selectedItem
    ? getItemArtworkUrl(selectedItem)
    : "";
  const targetDescription = selectedItem
    ? selectedItem.Type === "Series"
      ? formatTemplate(t("playbackDefaults.seriesTargetSummary"), {
          count: targetItems.length,
        })
      : t("playbackDefaults.movieTargetSummary")
    : t("playbackDefaults.noTitleSelected");
  const previewSummary = formatTemplate(t("playbackDefaults.previewSummary"), {
    audio: formatSelectedStreamIndex(selectedAudioStreamIndex, "audio", t),
    subtitles: formatSelectedStreamIndex(
      selectedSubtitleStreamIndex,
      "subtitle",
      t,
    ),
  });

  const selectItem = async (item: JellyfinItem) => {
    const requestId = loadTargetsRequestIdRef.current + 1;
    loadTargetsRequestIdRef.current = requestId;

    setSelectedItem(item);
    setTargetItems([]);
    setIsLoadingTargets(true);
    setTargetError(null);
    setSaveState(createEmptyResult());
    setSaveResults([]);
    setSelectedAudioStreamIndex(NO_AUDIO_STREAM_INDEX);
    setSelectedSubtitleStreamIndex(-1);

    try {
      const freshItem = await getItem(item.Id);
      const nextTargetItems =
        freshItem.Type === "Series"
          ? await getAllSeriesEpisodes(freshItem.Id)
          : [freshItem];

      if (loadTargetsRequestIdRef.current !== requestId) {
        return;
      }

      setSelectedItem(freshItem);
      setTargetItems(nextTargetItems);

      const commonAudioDefault = getCommonDefaultIndex(
        nextTargetItems,
        getDefaultAudioStreamIndexForItem,
      );
      const commonSubtitleDefault = getCommonDefaultIndex(
        nextTargetItems,
        getDefaultSubtitleStreamIndexForItem,
      );

      setSelectedAudioStreamIndex(commonAudioDefault ?? NO_AUDIO_STREAM_INDEX);
      setSelectedSubtitleStreamIndex(commonSubtitleDefault ?? -1);
    } catch (loadError) {
      if (loadTargetsRequestIdRef.current !== requestId) {
        return;
      }

      setTargetError(
        loadError instanceof Error
          ? loadError.message
          : t("playbackDefaults.targetLoadFailed"),
      );
      setTargetItems([]);
    } finally {
      if (loadTargetsRequestIdRef.current === requestId) {
        setIsLoadingTargets(false);
      }
    }
  };

  const saveDefaults = async () => {
    if (!selectedItem || !canSave) {
      return;
    }

    setSaveState({
      state: "loading",
      message: t("playbackDefaults.saving"),
    });
    setSaveResults([]);

    const nextResults: SaveResult[] = [];
    const nextTargetItems = [...targetItems];

    for (const targetItem of targetItems) {
      const nextItem = buildItemWithPlaybackDefaults(targetItem, {
        audioStreamIndex: selectedAudioStreamIndex,
        subtitleStreamIndex: selectedSubtitleStreamIndex,
      });

      try {
        await updateItemMetadata(targetItem.Id, nextItem);
        nextResults.push({
          itemId: targetItem.Id,
          title: getDisplayTitle(targetItem),
          status: "success",
        });

        const targetIndex = nextTargetItems.findIndex(
          (candidate) => candidate.Id === targetItem.Id,
        );

        if (targetIndex >= 0) {
          nextTargetItems[targetIndex] = nextItem;
        }
      } catch (saveError) {
        nextResults.push({
          itemId: targetItem.Id,
          title: getDisplayTitle(targetItem),
          status: "failed",
          message:
            saveError instanceof Error
              ? saveError.message
              : t("playbackDefaults.saveFailed"),
        });
      }

      setSaveResults([...nextResults]);
    }

    setTargetItems(nextTargetItems);

    if (selectedItem.Type !== "Series" && nextTargetItems[0]) {
      setSelectedItem(nextTargetItems[0]);
      setItems(
        (currentItems) =>
          currentItems?.map((item) =>
            item.Id === nextTargetItems[0].Id ? nextTargetItems[0] : item,
          ) ?? currentItems,
      );
    }

    const failedCount = nextResults.filter(
      (result) => result.status === "failed",
    ).length;

    setSaveState({
      state: failedCount > 0 ? "error" : "success",
      message:
        failedCount > 0
          ? formatTemplate(t("playbackDefaults.savePartial"), {
              success: nextResults.length - failedCount,
              failed: failedCount,
            })
          : formatTemplate(t("playbackDefaults.saveSuccess"), {
              count: nextResults.length,
            }),
    });
  };

  if (error) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorMessage
          title={t("playbackDefaults.unavailable")}
          message={error}
          details={t("playbackDefaults.adminRequired")}
        />
      </div>
    );
  }

  if (!items) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="text-center">
          <LoadingSpinner />
          <p className="mt-4 text-sm font-semibold text-white/50">
            {t("playbackDefaults.loading")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <section className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-6 shadow-2xl backdrop-blur-xl">
        <Link
          to="/dev"
          className="inline-flex items-center gap-2 text-sm font-black text-white/55 transition hover:text-white"
        >
          <ArrowLeft size={16} />
          {t("devtools.backToDevtools")}
        </Link>

        <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-black uppercase tracking-[0.22em] text-[var(--accent)]">
              {t("playbackDefaults.eyebrow")}
            </p>
            <h1 className="mt-2 text-3xl font-black text-white sm:text-4xl">
              {t("playbackDefaults.title")}
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-white/55">
              {t("playbackDefaults.description")}
            </p>
          </div>

          <div className="flex w-fit items-center gap-3 rounded-2xl border border-white/10 bg-black/24 px-4 py-3">
            <Film size={20} className="text-[var(--accent)]" />
            <div>
              <p className="text-xl font-black text-white">{items.length}</p>
              <p className="text-xs font-black uppercase tracking-[0.14em] text-white/38">
                {t("playbackDefaults.titles")}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-[24rem_minmax(0,1fr)]">
        <aside className="rounded-3xl border border-white/10 bg-black/30 p-4 shadow-2xl backdrop-blur-xl">
          <label className="relative block">
            <Search
              size={18}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-white/32"
            />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("playbackDefaults.searchPlaceholder")}
              aria-label={t("playbackDefaults.searchLabel")}
              className="min-h-12 w-full rounded-2xl border border-white/10 bg-white/[0.06] pl-11 pr-4 text-sm font-semibold text-white outline-none transition placeholder:text-white/30 focus:border-[var(--accent)]/55 focus:bg-white/[0.09]"
            />
          </label>

          <div className="mt-4 max-h-[42rem] space-y-2 overflow-y-auto pr-1">
            {filteredItems.map((item) => {
              const artworkUrl = getItemArtworkUrl(item);
              const isSelected = selectedItem?.Id === item.Id;

              return (
                <button
                  key={item.Id}
                  type="button"
                  onClick={() => void selectItem(item)}
                  className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition ${
                    isSelected
                      ? "border-[var(--accent)]/65 bg-[var(--accent)]/13"
                      : "border-white/10 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.07]"
                  }`}
                >
                  <div className="h-16 w-11 shrink-0 overflow-hidden rounded-lg bg-white/[0.08]">
                    {artworkUrl ? (
                      <img
                        src={artworkUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        loading="lazy"
                        draggable={false}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-white/30">
                        <Film size={18} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-black text-white">
                      {getDisplayTitle(item)}
                    </p>
                    <p className="mt-1 truncate text-xs font-bold text-white/42">
                      {[getItemTypeLabel(item, t), item.ProductionYear]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>

          {filteredItems.length === 0 ? (
            <p className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-sm font-semibold text-white/48">
              {t("playbackDefaults.noMatches")}
            </p>
          ) : null}
        </aside>

        <div className="space-y-5">
          <section className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
            {selectedItem ? (
              <div className="flex flex-col gap-5 md:flex-row">
                <div className="h-52 w-full overflow-hidden rounded-2xl bg-white/[0.06] md:h-auto md:w-36 md:shrink-0">
                  {selectedItemArtworkUrl ? (
                    <img
                      src={selectedItemArtworkUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-white/35">
                      <Film size={32} />
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-[var(--accent)]">
                    {getItemTypeLabel(selectedItem, t)}
                  </p>
                  <h2 className="mt-2 text-2xl font-black text-white">
                    {getDisplayTitle(selectedItem)}
                  </h2>
                  <p className="mt-2 text-sm font-semibold text-white/45">
                    {getItemSubtitle(selectedItem) ?? targetDescription}
                  </p>
                  <p className="mt-3 rounded-2xl border border-white/10 bg-white/[0.045] px-4 py-3 text-sm font-bold text-white/52">
                    {targetDescription}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex min-h-60 items-center justify-center rounded-2xl border border-dashed border-white/12 bg-white/[0.035] p-6 text-center">
                <div>
                  <Languages className="mx-auto h-9 w-9 text-white/35" />
                  <h2 className="mt-3 text-xl font-black text-white">
                    {t("playbackDefaults.noTitleSelected")}
                  </h2>
                  <p className="mt-2 max-w-lg text-sm font-semibold leading-6 text-white/45">
                    {t("playbackDefaults.noTitleSelectedDescription")}
                  </p>
                </div>
              </div>
            )}
          </section>

          {selectedItem ? (
            <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
              <div className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/10 text-white">
                    <Languages size={20} />
                  </div>
                  <div>
                    <h2 className="text-xl font-black text-white">
                      {t("playbackDefaults.formTitle")}
                    </h2>
                    <p className="text-sm font-semibold text-white/45">
                      {previewSummary}
                    </p>
                  </div>
                </div>

                {isLoadingTargets ? (
                  <div className="mt-5 flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-bold text-white/48">
                    <Loader2 size={18} className="animate-spin" />
                    {t("playbackDefaults.loadingTargets")}
                  </div>
                ) : targetError ? (
                  <div className="mt-5 rounded-2xl border border-rose-300/18 bg-rose-300/[0.07] px-4 py-3 text-sm font-bold text-rose-50/80">
                    {targetError}
                  </div>
                ) : (
                  <>
                    <div className="mt-5 grid gap-4 md:grid-cols-2">
                      <label className="block">
                        <span className="flex items-center gap-2 text-sm font-black text-white/72">
                          <Volume2 size={16} />
                          {t("playbackDefaults.audioStream")}
                        </span>
                        <select
                          value={String(selectedAudioStreamIndex)}
                          disabled={audioOptions.length === 0}
                          onChange={(event) =>
                            setSelectedAudioStreamIndex(
                              Number(event.target.value),
                            )
                          }
                          className="mt-2 min-h-12 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm font-semibold text-white outline-none transition focus:border-[var(--accent)]/55 disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          {selectedAudioStreamIndex === MIXED_STREAM_INDEX ? (
                            <option value={String(MIXED_STREAM_INDEX)}>
                              {t("playbackDefaults.mixed")}
                            </option>
                          ) : null}
                          {selectedAudioStreamIndex ===
                          NO_AUDIO_STREAM_INDEX ? (
                            <option value={String(NO_AUDIO_STREAM_INDEX)}>
                              {t("playbackDefaults.noAudioStreams")}
                            </option>
                          ) : null}
                          {selectedAudioStreamIndex >= 0 &&
                          !hasSelectedAudioOption ? (
                            <option value={String(selectedAudioStreamIndex)}>
                              {formatTemplate(
                                t("playbackDefaults.streamMissing"),
                                { index: selectedAudioStreamIndex },
                              )}
                            </option>
                          ) : null}
                          {audioOptions.map((option, optionIndex) => (
                            <option key={option.index} value={option.index}>
                              {[
                                getStreamLabel(
                                  option.stream,
                                  formatTemplate(t("settings.audioTrack"), {
                                    number: optionIndex + 1,
                                  }),
                                  t,
                                ),
                                getOptionCountLabel(
                                  option,
                                  targetItems.length,
                                  selectedItem,
                                  t,
                                ),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="block">
                        <span className="flex items-center gap-2 text-sm font-black text-white/72">
                          <Subtitles size={16} />
                          {t("playbackDefaults.subtitleStream")}
                        </span>
                        <select
                          value={String(selectedSubtitleStreamIndex)}
                          disabled={targetItems.length === 0}
                          onChange={(event) =>
                            setSelectedSubtitleStreamIndex(
                              Number(event.target.value),
                            )
                          }
                          className="mt-2 min-h-12 w-full rounded-2xl border border-white/10 bg-zinc-950 px-4 text-sm font-semibold text-white outline-none transition focus:border-[var(--accent)]/55 disabled:cursor-not-allowed disabled:opacity-55"
                        >
                          {selectedSubtitleStreamIndex ===
                          MIXED_STREAM_INDEX ? (
                            <option value={String(MIXED_STREAM_INDEX)}>
                              {t("playbackDefaults.mixed")}
                            </option>
                          ) : null}
                          <option value="-1">
                            {t("playbackDefaults.subtitlesOff")}
                          </option>
                          {selectedSubtitleStreamIndex >= 0 &&
                          !hasSelectedSubtitleOption ? (
                            <option value={String(selectedSubtitleStreamIndex)}>
                              {formatTemplate(
                                t("playbackDefaults.streamMissing"),
                                { index: selectedSubtitleStreamIndex },
                              )}
                            </option>
                          ) : null}
                          {subtitleOptions.map((option, optionIndex) => (
                            <option key={option.index} value={option.index}>
                              {[
                                getStreamLabel(
                                  option.stream,
                                  formatTemplate(t("settings.subtitle"), {
                                    number: optionIndex + 1,
                                  }),
                                  t,
                                ),
                                getOptionCountLabel(
                                  option,
                                  targetItems.length,
                                  selectedItem,
                                  t,
                                ),
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>

                    {audioOptions.length === 0 ? (
                      <p className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-bold text-white/48">
                        {t("playbackDefaults.noAudioStreams")}
                      </p>
                    ) : subtitleOptions.length === 0 ? (
                      <p className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm font-bold text-white/48">
                        {t("playbackDefaults.noSubtitleStreams")}
                      </p>
                    ) : null}

                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        onClick={() => void saveDefaults()}
                        disabled={!canSave}
                        className="rounded-full"
                      >
                        {saveState.state === "loading" ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Save size={16} />
                        )}
                        {formatTemplate(t("playbackDefaults.saveToItems"), {
                          count: targetItems.length,
                        })}
                      </Button>

                      <p className="text-xs font-semibold leading-5 text-white/38">
                        {t("playbackDefaults.applyWarning")}
                      </p>
                    </div>
                  </>
                )}

                {saveState.message ? (
                  <p
                    className={`mt-4 rounded-2xl border px-4 py-3 text-sm font-bold ${
                      saveState.state === "error"
                        ? "border-rose-300/18 bg-rose-300/[0.07] text-rose-50/80"
                        : saveState.state === "success"
                          ? "border-emerald-300/14 bg-emerald-300/[0.07] text-emerald-50/80"
                          : "border-white/10 bg-white/[0.06] text-white/62"
                    }`}
                  >
                    {saveState.message}
                  </p>
                ) : null}
              </div>

              <aside className="space-y-4">
                <div className="rounded-3xl border border-amber-300/18 bg-amber-300/[0.07] p-5 shadow-2xl">
                  <div className="flex items-start gap-3">
                    <AlertTriangle
                      size={20}
                      className="mt-0.5 shrink-0 text-amber-100"
                    />
                    <div>
                      <h2 className="text-sm font-black text-amber-50">
                        {t("playbackDefaults.adminRequiredTitle")}
                      </h2>
                      <p className="mt-2 text-sm font-semibold leading-6 text-amber-50/58">
                        {t("playbackDefaults.adminRequired")}
                      </p>
                    </div>
                  </div>
                </div>

                {saveResults.length > 0 ? (
                  <div className="rounded-3xl border border-white/10 bg-black/30 p-5 shadow-2xl backdrop-blur-xl">
                    <h2 className="text-base font-black text-white">
                      {t("playbackDefaults.results")}
                    </h2>
                    <p className="mt-1 text-sm font-semibold text-white/42">
                      {formatTemplate(t("playbackDefaults.resultSummary"), {
                        success: successfulResultCount,
                        failed: failedResultCount,
                      })}
                    </p>

                    <div className="mt-4 max-h-80 space-y-2 overflow-y-auto pr-1">
                      {saveResults.map((result) => (
                        <div
                          key={result.itemId}
                          className={`rounded-2xl border p-3 ${
                            result.status === "success"
                              ? "border-emerald-300/14 bg-emerald-300/[0.07]"
                              : "border-rose-300/18 bg-rose-300/[0.07]"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            {result.status === "success" ? (
                              <CheckCircle2
                                size={16}
                                className="text-emerald-100"
                              />
                            ) : (
                              <AlertTriangle
                                size={16}
                                className="text-rose-100"
                              />
                            )}
                            <p className="truncate font-black text-white">
                              {result.title}
                            </p>
                          </div>
                          {result.message ? (
                            <p className="mt-1 text-xs font-semibold text-rose-50/68">
                              {result.message}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </aside>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
