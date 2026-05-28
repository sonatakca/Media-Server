import type { JellyfinItem, PlaybackSourceCandidate } from "./types";

const SUBTITLE_PREFERENCES_STORAGE_KEY =
  "seyirlik.subtitle-default-preferences.v1";

type SubtitlePreferenceMap = Record<string, number>;

export interface SubtitlePreferenceUpdate {
  itemId: string;
  subtitleStreamIndex: number;
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && Boolean(window.localStorage);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSubtitleStreamIndex(value: number): number {
  if (!Number.isFinite(value)) return -1;
  return Math.trunc(value);
}

function readSubtitlePreferenceMap(): SubtitlePreferenceMap {
  if (!canUseLocalStorage()) return {};

  try {
    const raw = window.localStorage.getItem(SUBTITLE_PREFERENCES_STORAGE_KEY);

    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) return {};

    return Object.entries(parsed).reduce<SubtitlePreferenceMap>(
      (preferences, [itemId, value]) => {
        if (typeof value === "number" && Number.isFinite(value)) {
          preferences[itemId] = normalizeSubtitleStreamIndex(value);
        }

        return preferences;
      },
      {},
    );
  } catch {
    return {};
  }
}

function writeSubtitlePreferenceMap(preferences: SubtitlePreferenceMap): void {
  if (!canUseLocalStorage()) return;

  window.localStorage.setItem(
    SUBTITLE_PREFERENCES_STORAGE_KEY,
    JSON.stringify(preferences),
  );
}

export function getStoredDefaultSubtitleStreamIndex(
  itemId: string | undefined,
): number | null {
  if (!itemId) return null;

  const preferences = readSubtitlePreferenceMap();
  return Object.prototype.hasOwnProperty.call(preferences, itemId)
    ? preferences[itemId]
    : null;
}

export function getDefaultSubtitleStreamIndexForItem(
  item: JellyfinItem,
): number {
  return (
    getStoredDefaultSubtitleStreamIndex(item.Id) ??
    item.MediaSources?.[0]?.DefaultSubtitleStreamIndex ??
    -1
  );
}

export function getDefaultSubtitleStreamIndexForSource(
  source: PlaybackSourceCandidate,
): number {
  return (
    getStoredDefaultSubtitleStreamIndex(source.itemId) ??
    source.mediaSource.DefaultSubtitleStreamIndex ??
    -1
  );
}

export function saveDefaultSubtitleStreamPreferences(
  updates: SubtitlePreferenceUpdate[],
): void {
  const preferences = readSubtitlePreferenceMap();

  updates.forEach(({ itemId, subtitleStreamIndex }) => {
    if (!itemId) return;
    preferences[itemId] = normalizeSubtitleStreamIndex(subtitleStreamIndex);
  });

  writeSubtitlePreferenceMap(preferences);
}
