import type { TranslationKey } from "../../i18n/translations";
import { getDefaultSubtitleStreamIndexForItem } from "../../lib/subtitlePreferences";
import type { JellyfinItem, JellyfinMediaStream } from "../../lib/types";

export type ActionState = "idle" | "loading" | "success" | "error";
export type Translate = (key: TranslationKey) => string;

export interface ActionResult {
  state: ActionState;
  message: string;
}

export interface MetadataDraft {
  name: string;
  sortName: string;
  overview: string;
  productionYear: string;
  officialRating: string;
  communityRating: string;
  genres: string;
}

export interface SubtitlePreferenceOption {
  index: number;
  stream: JellyfinMediaStream;
  itemCount: number;
}

export const MIXED_SUBTITLE_PREFERENCE_INDEX = -2;

export function createEmptyResult(): ActionResult {
  return {
    state: "idle",
    message: "",
  };
}

export function createDraftFromItem(item: JellyfinItem): MetadataDraft {
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

export function getDefaultSubtitlePreferenceIndex(item: JellyfinItem): number {
  return getDefaultSubtitleStreamIndexForItem(item);
}

export function getSubtitleStreams(
  item: JellyfinItem | null,
): JellyfinMediaStream[] {
  return (
    item?.MediaSources?.[0]?.MediaStreams?.filter(
      (stream) => stream.Type?.toLowerCase() === "subtitle",
    ) ?? []
  );
}

export function getSubtitleStreamLabel(
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

export function getCommonSubtitlePreferenceIndex(
  items: JellyfinItem[],
): number {
  if (items.length === 0) return -1;

  const firstPreference = getDefaultSubtitlePreferenceIndex(items[0]);

  return items.every(
    (item) => getDefaultSubtitlePreferenceIndex(item) === firstPreference,
  )
    ? firstPreference
    : MIXED_SUBTITLE_PREFERENCE_INDEX;
}

export function getSubtitlePreferenceOptions(
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

export function getSubtitlePreferenceTargetItems(
  selectedItem: JellyfinItem | null,
  seriesEpisodes: JellyfinItem[],
): JellyfinItem[] {
  if (!selectedItem) return [];
  if (selectedItem.Type === "Series") return seriesEpisodes;
  return [selectedItem];
}

export function formatTemplate(
  template: string,
  values: Record<string, string | number>,
): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

export function getTypeLabel(item: JellyfinItem, t: Translate) {
  if (item.Type === "Movie") return t("common.movie");
  if (item.Type === "Episode") return t("common.episode");
  if (item.Type === "Series") return t("common.series");
  if (item.Type === "Season") return t("common.season");
  if (item.Type === "Folder") return t("common.folder");
  return item.Type ?? t("common.item");
}

export function parseNumberOrUndefined(value: string): number | undefined {
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

export function parseGenres(value: string): string[] {
  return value
    .split(",")
    .map((genre) => genre.trim())
    .filter(Boolean);
}

export function formatBoolean(
  value: boolean | undefined,
  t: Translate,
): string {
  if (value === true) return t("common.yes");
  if (value === false) return t("common.no");
  return t("common.unknown");
}

export function formatBytes(
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

export function formatBitrate(
  value: number | undefined,
  unknownLabel = "Unknown",
): string {
  if (!value || value <= 0) return unknownLabel;
  return `${(value / 1_000_000).toFixed(2)} Mbps`;
}

export function formatTicks(value: number | undefined, t: Translate): string {
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

export function getDetailValue(value: unknown, t: Translate): string {
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
