import type {
  MediaItem,
  MediaSource,
  MediaStream,
  PlaybackSourceCandidate,
} from "./types";
import { isTurkishSubtitleLanguage } from "./subtitleLanguages";

const LEGACY_SUBTITLE_PREFERENCES_STORAGE_KEY =
  "seyirlik.subtitle-default-preferences.v1";

const AUDIO_PROVIDER_ID_KEY = "SeyirlikDefaultAudioStreamIndex";
const SUBTITLE_PROVIDER_ID_KEY = "SeyirlikDefaultSubtitleStreamIndex";

type SubtitlePreferenceMap = Record<string, number>;

export interface SubtitlePreferenceUpdate {
  itemId: string;
  subtitleStreamIndex: number;
}

export interface ItemPlaybackDefaults {
  audioStreamIndex?: number;
  subtitleStreamIndex?: number;
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

function normalizeStreamIndex(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }

  return null;
}

function readLegacySubtitlePreferenceMap(): SubtitlePreferenceMap {
  if (!canUseLocalStorage()) return {};

  try {
    const raw = window.localStorage.getItem(
      LEGACY_SUBTITLE_PREFERENCES_STORAGE_KEY,
    );

    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);

    if (!isRecord(parsed)) return {};

    return Object.entries(parsed).reduce<SubtitlePreferenceMap>(
      (preferences, [itemId, value]) => {
        const streamIndex = normalizeStreamIndex(value);

        if (streamIndex !== null) {
          preferences[itemId] = streamIndex;
        }

        return preferences;
      },
      {},
    );
  } catch {
    return {};
  }
}

function writeLegacySubtitlePreferenceMap(
  preferences: SubtitlePreferenceMap,
): void {
  if (!canUseLocalStorage()) return;

  window.localStorage.setItem(
    LEGACY_SUBTITLE_PREFERENCES_STORAGE_KEY,
    JSON.stringify(preferences),
  );
}

function getStreamsOfType(
  mediaSource: MediaSource | undefined,
  type: "Audio" | "Subtitle",
): MediaStream[] {
  return (
    mediaSource?.MediaStreams?.filter(
      (stream) => stream.Type?.toLowerCase() === type.toLowerCase(),
    ) ?? []
  );
}

function getFallbackDefaultAudioStreamIndex(
  mediaSource: MediaSource | undefined,
): number | undefined {
  const audioStreams = getStreamsOfType(mediaSource, "Audio");

  return (
    mediaSource?.DefaultAudioStreamIndex ??
    audioStreams.find((stream) => stream.IsDefault)?.Index ??
    audioStreams[0]?.Index
  );
}

function getTurkishSubtitleStreamIndex(
  mediaSource: MediaSource | undefined,
): number | undefined {
  return getStreamsOfType(mediaSource, "Subtitle").find(
    (stream) =>
      stream.Index !== undefined && isTurkishSubtitleLanguage(stream.Language),
  )?.Index;
}

export function getStoredItemPlaybackDefaults(
  item: MediaItem | undefined,
): ItemPlaybackDefaults {
  if (!item?.ProviderIds) {
    return {};
  }

  const audioStreamIndex = normalizeStreamIndex(
    item.ProviderIds[AUDIO_PROVIDER_ID_KEY],
  );
  const subtitleStreamIndex = normalizeStreamIndex(
    item.ProviderIds[SUBTITLE_PROVIDER_ID_KEY],
  );

  return {
    ...(audioStreamIndex !== null ? { audioStreamIndex } : {}),
    ...(subtitleStreamIndex !== null ? { subtitleStreamIndex } : {}),
  };
}

export function getStoredDefaultSubtitleStreamIndex(
  itemId: string | undefined,
): number | null {
  if (!itemId) return null;

  const preferences = readLegacySubtitlePreferenceMap();
  return Object.prototype.hasOwnProperty.call(preferences, itemId)
    ? preferences[itemId]
    : null;
}

export function getDefaultAudioStreamIndexForItem(
  item: MediaItem,
): number | undefined {
  const storedDefaults = getStoredItemPlaybackDefaults(item);

  return (
    storedDefaults.audioStreamIndex ??
    getFallbackDefaultAudioStreamIndex(item.MediaSources?.[0])
  );
}

export function getDefaultAudioStreamIndexForSource(
  item: MediaItem,
  source: PlaybackSourceCandidate,
): number | undefined {
  const storedDefaults = getStoredItemPlaybackDefaults(item);

  return (
    storedDefaults.audioStreamIndex ??
    getFallbackDefaultAudioStreamIndex(source.mediaSource)
  );
}

export function getDefaultSubtitleStreamIndexForItem(item: MediaItem): number {
  const storedDefaults = getStoredItemPlaybackDefaults(item);

  return (
    storedDefaults.subtitleStreamIndex ??
    getStoredDefaultSubtitleStreamIndex(item.Id) ??
    getTurkishSubtitleStreamIndex(item.MediaSources?.[0]) ??
    item.MediaSources?.[0]?.DefaultSubtitleStreamIndex ??
    -1
  );
}

export function getDefaultSubtitleStreamIndexForSource(
  item: MediaItem,
  source: PlaybackSourceCandidate,
): number {
  const storedDefaults = getStoredItemPlaybackDefaults(item);

  return (
    storedDefaults.subtitleStreamIndex ??
    getStoredDefaultSubtitleStreamIndex(source.itemId) ??
    getTurkishSubtitleStreamIndex(source.mediaSource) ??
    source.mediaSource.DefaultSubtitleStreamIndex ??
    -1
  );
}

export function buildItemWithPlaybackDefaults(
  item: MediaItem,
  defaults: ItemPlaybackDefaults,
): MediaItem {
  const providerIds = { ...(item.ProviderIds ?? {}) };

  if (defaults.audioStreamIndex === undefined) {
    delete providerIds[AUDIO_PROVIDER_ID_KEY];
  } else {
    providerIds[AUDIO_PROVIDER_ID_KEY] = String(
      Math.trunc(defaults.audioStreamIndex),
    );
  }

  if (defaults.subtitleStreamIndex === undefined) {
    delete providerIds[SUBTITLE_PROVIDER_ID_KEY];
  } else {
    providerIds[SUBTITLE_PROVIDER_ID_KEY] = String(
      Math.trunc(defaults.subtitleStreamIndex),
    );
  }

  return {
    ...item,
    ProviderIds: providerIds,
  };
}

export function saveDefaultSubtitleStreamPreferences(
  updates: SubtitlePreferenceUpdate[],
): void {
  const preferences = readLegacySubtitlePreferenceMap();

  updates.forEach(({ itemId, subtitleStreamIndex }) => {
    if (!itemId) return;
    preferences[itemId] = Math.trunc(subtitleStreamIndex);
  });

  writeLegacySubtitlePreferenceMap(preferences);
}
