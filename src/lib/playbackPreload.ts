import {
  buildPlaybackCandidates,
  getItem,
  getPlaybackInfo,
  redactPlaybackUrl,
} from "./jellyfinApi";
import {
  isCustomPlaybackBackendConfigured,
  requestCustomPlaybackCandidate,
} from "./playback-planner/customPlaybackApi";
import { releaseCustomPlaybackSession } from "./playback-planner/customPlaybackSessionLease";
import { getPlayTargetItemForItem } from "./playTarget";
import type {
  JellyfinItem,
  JellyfinPlaybackInfoResponse,
  PlaybackSourceCandidate,
} from "./types";

const PLAYBACK_SOURCE_CACHE_TTL_MS = 2 * 60 * 1000;
const PRELOADED_ITEM_CACHE_TTL_MS = 5 * 60 * 1000;

export interface PreloadedPlaybackSource {
  itemId: string;
  candidates: PlaybackSourceCandidate[];
  createdAtMs: number;
}

interface CachedPlaybackItem {
  item: JellyfinItem;
  createdAtMs: number;
}

const playbackSourceCache = new Map<string, PreloadedPlaybackSource>();
const playbackSourcePromises = new Map<
  string,
  Promise<PreloadedPlaybackSource>
>();
const playbackItemCache = new Map<string, CachedPlaybackItem>();

export class NoPlayablePlaybackSourceError extends Error {
  playbackInfo: JellyfinPlaybackInfoResponse;

  constructor(playbackInfo: JellyfinPlaybackInfoResponse) {
    super("No playable source returned.");
    this.name = "NoPlayablePlaybackSourceError";
    this.playbackInfo = playbackInfo;
  }
}

function isFresh(createdAtMs: number, ttlMs: number): boolean {
  return Date.now() - createdAtMs < ttlMs;
}

function writeCachedPlaybackSource(
  itemId: string,
  candidates: PlaybackSourceCandidate[],
): PreloadedPlaybackSource {
  const value: PreloadedPlaybackSource = {
    itemId,
    candidates,
    createdAtMs: Date.now(),
  };

  playbackSourceCache.set(itemId, value);
  return value;
}

export function readCachedPlaybackSource(
  itemId: string,
): PreloadedPlaybackSource | null {
  const cached = playbackSourceCache.get(itemId);

  if (!cached) {
    return null;
  }

  if (!isFresh(cached.createdAtMs, PLAYBACK_SOURCE_CACHE_TTL_MS)) {
    playbackSourceCache.delete(itemId);
    return null;
  }

  return cached;
}

export function writePreloadedPlaybackItem(item: JellyfinItem): void {
  playbackItemCache.set(item.Id, {
    item,
    createdAtMs: Date.now(),
  });
}

export function readPreloadedPlaybackItem(itemId: string): JellyfinItem | null {
  const cached = playbackItemCache.get(itemId);

  if (!cached) {
    return null;
  }

  if (!isFresh(cached.createdAtMs, PRELOADED_ITEM_CACHE_TTL_MS)) {
    playbackItemCache.delete(itemId);
    return null;
  }

  return cached.item;
}

function warmHlsManifest(source: PlaybackSourceCandidate): void {
  if (!source.isHls) {
    return;
  }

  void fetch(source.url, { method: "GET", cache: "no-store" }).catch(
    (error) => {
      console.debug("[Seyirlik Playback] HLS manifest preload skipped", error);
    },
  );
}

function scheduleUnusedCustomSessionRelease(
  source: PlaybackSourceCandidate,
): void {
  releaseCustomPlaybackSession(source, {
    graceMs: PLAYBACK_SOURCE_CACHE_TTL_MS,
  });
}

async function loadPlaybackSource(
  itemId: string,
): Promise<PreloadedPlaybackSource> {
  if (isCustomPlaybackBackendConfigured()) {
    try {
      const customCandidate = await requestCustomPlaybackCandidate(itemId);

      if (customCandidate) {
        console.info("[Seyirlik Playback] Custom PlaybackPlan received", {
          mode: customCandidate.mode,
          hlsKind: customCandidate.hlsKind,
          reason: customCandidate.reason,
          url: redactPlaybackUrl(customCandidate.url),
        });

        const preloadedSource = writeCachedPlaybackSource(itemId, [
          customCandidate,
        ]);
        warmHlsManifest(customCandidate);
        scheduleUnusedCustomSessionRelease(customCandidate);
        return preloadedSource;
      }
    } catch (error) {
      console.warn(
        "[Seyirlik Playback] Custom backend failed; falling back to Jellyfin PlaybackInfo",
        error,
      );
    }
  }

  const playbackInfo = await getPlaybackInfo(itemId);
  const candidates = buildPlaybackCandidates(itemId, playbackInfo);

  console.info("[Seyirlik Playback] PlaybackInfo received", {
    playSessionId: playbackInfo.PlaySessionId,
    mediaSources: playbackInfo.MediaSources?.length ?? 0,
    errorCode: playbackInfo.ErrorCode,
  });

  if (candidates.length === 0) {
    throw new NoPlayablePlaybackSourceError(playbackInfo);
  }

  const preloadedSource = writeCachedPlaybackSource(itemId, candidates);
  warmHlsManifest(candidates[0]);
  return preloadedSource;
}

export function preloadPlaybackSource(
  itemId: string,
  options?: { force?: boolean },
): Promise<PreloadedPlaybackSource> {
  const cached = options?.force ? null : readCachedPlaybackSource(itemId);

  if (cached) {
    return Promise.resolve(cached);
  }

  if (!options?.force) {
    const pending = playbackSourcePromises.get(itemId);

    if (pending) {
      return pending;
    }
  }

  const promise = loadPlaybackSource(itemId).finally(() => {
    if (playbackSourcePromises.get(itemId) === promise) {
      playbackSourcePromises.delete(itemId);
    }
  });

  playbackSourcePromises.set(itemId, promise);
  return promise;
}

export async function preloadMediaPlayback(
  item: JellyfinItem,
  options?: { preloadPlayer?: () => void | Promise<unknown> },
): Promise<JellyfinItem | null> {
  try {
    void Promise.resolve(options?.preloadPlayer?.()).catch((error) => {
      console.debug("[Seyirlik Playback] Player chunk preload skipped", error);
    });
  } catch (error) {
    console.debug("[Seyirlik Playback] Player chunk preload skipped", error);
  }

  const targetItem = await getPlayTargetItemForItem(item);

  if (!targetItem) {
    return null;
  }

  writePreloadedPlaybackItem(targetItem);
  void getItem(targetItem.Id)
    .then(writePreloadedPlaybackItem)
    .catch((error) => {
      console.debug("[Seyirlik Playback] Item preload refresh skipped", error);
    });

  await preloadPlaybackSource(targetItem.Id);
  return targetItem;
}
