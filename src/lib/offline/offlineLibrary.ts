import { ownApiClient, ownApiUrl } from "../../api/ownApi/client";
import type { Language } from "../../i18n/translations";
import { getItemLogoUrlById } from "../itemMetadataPreferences";
import {
  getBackdropImageUrl,
  getItemTrickplayImageUrl,
  getLogoImageUrl,
  getPrimaryImageUrl,
} from "../mediaApi";
import type { MediaItem, MediaStream, PlaybackSourceCandidate } from "../types";
import {
  isMultivariantPlaylist,
  playlistReferences,
  withoutIFramePlaylists,
} from "./playlist";

/**
 * Titles kept on this device for watching without a connection.
 *
 * The bytes live in Cache Storage under the very URLs playback uses, so the
 * service worker (`public/offline-sw.js`) can answer them when the network
 * cannot; a small IndexedDB record per title says what was kept and how much
 * of it has arrived. Nothing here is shared between devices or reported to
 * the server: a download belongs to the browser that made it.
 */

/** Must match `OFFLINE_CACHE` in `public/offline-sw.js`. */
export const OFFLINE_CACHE = "seyirlik-offline-v1";
const DATABASE = "seyirlik-offline";
const STORE = "titles";

export interface DownloadPlan {
  itemId: string;
  masterUrl: string;
  segmentTargetSeconds: number;
  qualities: Array<{
    height: number;
    width: number;
    bitrate: number;
    videoCodec: "h264" | "hevc";
    hdr: boolean;
  }>;
  audioTracks: Array<{
    sourceStreamIndex: number;
    label: string;
    language?: string;
    isDefault: boolean;
  }>;
  /** Text subtitle tracks; absent from a server older than this field. */
  subtitles?: Array<{
    streamIndex: number;
    /** The package's own converted copy, preferred over extraction. */
    url?: string;
  }>;
}

export type DownloadState = "downloading" | "complete" | "failed";

export interface OfflineTitle {
  itemId: string;
  /** The item as it was when downloaded, for the pages to show offline. */
  item: MediaItem;
  /** The master playlist URL the stored copy answers to. */
  masterUrl: string;
  height: number;
  width: number;
  bitrate: number;
  hdr: boolean;
  /** Every stored URL, so removal can take exactly these. */
  files: string[];
  downloadedBytes: number;
  estimatedBytes: number;
  state: DownloadState;
  createdAt: string;
  updatedAt: string;
  /**
   * The audio and subtitle tracks this copy carries, by source stream index.
   * Absent on a title stored before every track was kept.
   */
  audioStreamIndexes?: number[];
  subtitleStreamIndexes?: number[];
}

function absoluteUrl(url: string): string {
  return typeof window === "undefined"
    ? url
    : new URL(url, window.location.href).toString();
}

/**
 * The artwork URLs a download stores, which the Downloads page must request
 * exactly — the service worker matches on the whole URL, query included.
 */
export function offlineArtworkUrls(item: MediaItem): {
  poster: string;
  backdrop: string;
  logos: string[];
} {
  return {
    poster: absoluteUrl(
      getPrimaryImageUrl(item.Id, item.ImageTags?.Primary, 400),
    ),
    backdrop: absoluteUrl(
      getBackdropImageUrl(item.Id, item.BackdropImageTags?.[0], 1280),
    ),
    logos: titleLogoUrls(item).map(absoluteUrl),
  };
}

/**
 * The title logo the player lays over the picture, chosen the way the player
 * chooses it: the series' logo for an episode, a logo picked for a language
 * when there is one, the item's own otherwise.
 */
function titleLogoUrls(item: MediaItem): string[] {
  const seriesLogoItemId =
    item.Type === "Episode"
      ? (item.ParentLogoItemId ?? item.SeriesId ?? null)
      : null;
  const fallback =
    seriesLogoItemId && item.ParentLogoImageTag
      ? getLogoImageUrl(seriesLogoItemId, item.ParentLogoImageTag, 900)
      : item.ImageTags?.Logo
        ? getLogoImageUrl(item.Id, item.ImageTags.Logo, 900)
        : "";
  const languages: Language[] = ["tr", "en"];
  return [
    ...new Set(
      languages.map((language) =>
        getItemLogoUrlById(seriesLogoItemId ?? item.Id, language, fallback),
      ),
    ),
  ].filter(Boolean);
}

/**
 * Where a stored copy keeps one subtitle track. Fetched from the download
 * route, which needs no playback session, and asked for there again offline.
 */
export function offlineSubtitleUrl(itemId: string, streamIndex: number) {
  return absoluteUrl(
    ownApiUrl(
      `/ownAPI/v1/downloads/items/${encodeURIComponent(itemId)}/subtitles/${streamIndex}.vtt`,
    ),
  );
}

export function isOfflineSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "caches" in window &&
    "indexedDB" in window &&
    "serviceWorker" in navigator
  );
}

/**
 * Whether this device has no connection at all, rather than only the server
 * being out of reach. The front end is served from somewhere other than the
 * API, so when even its `/version.json` cannot be fetched, nothing can.
 */
export async function isDeviceOffline(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  const abort = new AbortController();
  const timer = window.setTimeout(() => abort.abort(), 5000);
  try {
    await fetch(`/version.json?t=${Date.now()}`, {
      cache: "no-store",
      credentials: "omit",
      signal: abort.signal,
    });
    return false;
  } catch {
    return true;
  } finally {
    window.clearTimeout(timer);
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "itemId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = operation(
        database.transaction(STORE, mode).objectStore(STORE),
      );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

export async function listOfflineTitles(): Promise<OfflineTitle[]> {
  if (!isOfflineSupported()) return [];
  const titles = await withStore<OfflineTitle[]>("readonly", (store) =>
    store.getAll(),
  );
  return titles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getOfflineTitle(
  itemId: string,
): Promise<OfflineTitle | null> {
  if (!isOfflineSupported()) return null;
  return (
    (await withStore<OfflineTitle | undefined>("readonly", (store) =>
      store.get(itemId),
    )) ?? null
  );
}

async function saveOfflineTitle(title: OfflineTitle): Promise<void> {
  await withStore("readwrite", (store) => store.put(title));
  window.dispatchEvent(
    new CustomEvent("seyirlik:offline-changed", { detail: title.itemId }),
  );
}

/** Asks the server what can be downloaded; refused if the account may not. */
export async function getDownloadPlan(
  itemId: string,
  supportsHevc: boolean,
): Promise<DownloadPlan> {
  return ownApiClient.request<DownloadPlan>(
    `/downloads/items/${encodeURIComponent(itemId)}/plan?hevc=${supportsHevc ? 1 : 0}`,
  );
}

/** The rung a download takes by default: 1080p or the nearest below it. */
export function defaultDownloadHeight(plan: DownloadPlan): number {
  const heights = plan.qualities
    .map((quality) => quality.height)
    .sort((a, b) => a - b);
  return heights.filter((height) => height <= 1080).pop() ?? heights[0] ?? 720;
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  return response.text();
}

/**
 * How much of a package file one stored entry holds.
 *
 * A package keeps each quality in one file, which for a feature film at
 * 1080p is several gigabytes. WebKit refuses a single Cache Storage entry
 * somewhere past a gigabyte (`QuotaExceededError`) while happily storing many
 * smaller ones, so a file is fetched in ranges and kept as parts, with a small
 * index under the file's own URL. It also makes a resumed download continue
 * from its last part rather than from the start of the file.
 */
const PART_BYTES = 32 * 1024 * 1024;
/** Must match `PARTS_CONTENT_TYPE` in `public/offline-sw.js`. */
const PARTS_CONTENT_TYPE = "application/vnd.seyirlik.parts+json";
const PART_SIZE_HEADER = "X-Seyirlik-Size";
const PART_LENGTH_HEADER = "X-Seyirlik-Part-Length";

/** Must build the same key as `partUrl` in `public/offline-sw.js`. */
function partUrl(url: string, index: number): string {
  const part = new URL(url);
  part.searchParams.set("seyirlik-part", String(index));
  return part.toString();
}

function countingStream(onBytes: (bytes: number) => void) {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
}

/**
 * Stores one package file as parts plus an index, returning every key stored.
 *
 * The index is written last, so its presence means every part is there. A
 * server that ignores the range gets its whole response stored as before.
 */
async function storeInParts(
  cache: Cache,
  url: string,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
): Promise<string[]> {
  const files: string[] = [];
  let size: number | undefined;
  let contentType = "application/octet-stream";
  let offset = 0;
  for (let index = 0; size === undefined || offset < size; index += 1) {
    const key = partUrl(url, index);
    const stored = await cache.match(key);
    const storedSize = Number(stored?.headers.get(PART_SIZE_HEADER));
    const storedLength = Number(stored?.headers.get(PART_LENGTH_HEADER));
    if (stored && storedSize > 0 && storedLength > 0) {
      size = storedSize;
      contentType = stored.headers.get("Content-Type") ?? contentType;
      onBytes(storedLength);
      offset += storedLength;
      files.push(key);
      continue;
    }

    const response = await fetch(url, {
      credentials: "include",
      signal,
      headers: { Range: `bytes=${offset}-${offset + PART_BYTES - 1}` },
    });
    if (response.status === 200 && offset === 0 && response.body) {
      await cache.put(
        url,
        new Response(response.body.pipeThrough(countingStream(onBytes)), {
          status: 200,
          headers: {
            "Content-Type":
              response.headers.get("Content-Type") ??
              "application/octet-stream",
          },
        }),
      );
      return [url];
    }
    const total = /\/(\d+)\s*$/.exec(
      response.headers.get("Content-Range") ?? "",
    )?.[1];
    if (response.status !== 206 || !response.body || !total) {
      throw new Error(`Download failed (${response.status}).`);
    }
    size = Number(total);
    contentType = response.headers.get("Content-Type") ?? contentType;
    const length = Math.min(PART_BYTES, size - offset);
    await cache.put(
      key,
      new Response(response.body.pipeThrough(countingStream(onBytes)), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          [PART_SIZE_HEADER]: String(size),
          [PART_LENGTH_HEADER]: String(length),
        },
      }),
    );
    offset += length;
    files.push(key);
  }

  await cache.put(
    url,
    new Response(JSON.stringify({ size, partBytes: PART_BYTES, contentType }), {
      headers: { "Content-Type": PARTS_CONTENT_TYPE },
    }),
  );
  files.push(url);
  return files;
}

/**
 * Stores a small extra a title may not have: a subtitle track, a sheet of
 * seek thumbnails, a title logo. False when the server has none to give; a failure to reach
 * it is still an error, so a dropped connection is not mistaken for absence.
 */
async function storeOptional(
  cache: Cache,
  url: string,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
  /** Where to fetch it from, when that is not where it is asked for. */
  sourceUrl = url,
): Promise<boolean> {
  if (await cache.match(url)) return true;
  const response = await fetch(sourceUrl, { credentials: "include", signal });
  if (response.status >= 400 && response.status < 500) return false;
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}).`);
  }
  await cache.put(
    url,
    new Response(response.body.pipeThrough(countingStream(onBytes)), {
      status: 200,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") ?? "application/octet-stream",
      },
    }),
  );
  return true;
}

/** How many sheets of seek thumbnails the title has; 0 when none. */
async function trickplaySpriteCount(
  itemId: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const response = await fetch(
    ownApiUrl(`/ownAPI/v1/items/${encodeURIComponent(itemId)}/trickplay`),
    { credentials: "include", signal },
  );
  if (response.status === 404) return 0;
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const body = (await response.json()) as { data?: { spriteCount?: number } };
  return body.data?.spriteCount ?? 0;
}

/** Stores one response, counting its bytes as they arrive. */
async function storeCounted(
  cache: Cache,
  url: string,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
): Promise<void> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}).`);
  }
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      onBytes(chunk.byteLength);
      controller.enqueue(chunk);
    },
  });
  await cache.put(
    url,
    new Response(response.body.pipeThrough(counter), {
      status: 200,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") ?? "application/octet-stream",
      },
    }),
  );
}

/**
 * Downloads one title at one quality.
 *
 * Resumable by construction: every file already in the cache is skipped, so
 * calling this again after a closed tab or a dropped connection continues
 * where the last attempt stopped instead of starting over.
 */
export async function downloadTitle(
  item: MediaItem,
  plan: DownloadPlan,
  height: number,
  options: {
    signal?: AbortSignal;
    onProgress?: (title: OfflineTitle) => void;
  } = {},
): Promise<OfflineTitle> {
  const quality =
    plan.qualities.find((candidate) => candidate.height === height) ??
    plan.qualities[0];
  if (!quality) throw new Error("This title has nothing to download.");

  // Asked once; a browser that grants it will not evict the copy under
  // storage pressure without asking.
  await navigator.storage?.persist?.().catch(() => false);

  // Absolute, so playlist entries resolve against it — the API origin is
  // empty (same-origin) on every server but the Vercel front end.
  const masterUrl = new URL(
    `${ownApiUrl(plan.masterUrl)}?height=${quality.height}`,
    window.location.href,
  ).toString();
  const durationSeconds =
    typeof item.RunTimeTicks === "number" ? item.RunTimeTicks / 10_000_000 : 0;
  const now = new Date().toISOString();
  const existing = await getOfflineTitle(item.Id);
  const title: OfflineTitle = {
    itemId: item.Id,
    item,
    masterUrl,
    height: quality.height,
    width: quality.width,
    bitrate: quality.bitrate,
    hdr: quality.hdr,
    files: [],
    downloadedBytes: 0,
    // Video plus a stereo AAC track per dub: the part a bitrate leaves out.
    estimatedBytes: Math.round(
      (durationSeconds *
        (quality.bitrate + 192_000 * Math.max(1, plan.audioTracks.length))) /
        8,
    ),
    state: "downloading",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    audioStreamIndexes: plan.audioTracks.map(
      (track) => track.sourceStreamIndex,
    ),
    subtitleStreamIndexes: [],
  };
  await saveOfflineTitle(title);

  const cache = await caches.open(OFFLINE_CACHE);
  let lastReport = 0;
  const report = (force = false) => {
    const moment = Date.now();
    if (!force && moment - lastReport < 500) return;
    lastReport = moment;
    title.updatedAt = new Date().toISOString();
    options.onProgress?.({ ...title });
  };

  try {
    const master = withoutIFramePlaylists(
      await fetchText(masterUrl, options.signal),
    );
    if (!isMultivariantPlaylist(master)) {
      throw new Error("The server did not return a playable package.");
    }
    await cache.put(
      masterUrl,
      new Response(master, {
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      }),
    );
    title.files.push(masterUrl);

    // Artwork, so the Downloads page is not a list of grey boxes offline,
    // and the logo the player shows over the picture.
    const artworkUrls = offlineArtworkUrls(item);
    for (const artwork of [
      artworkUrls.poster,
      artworkUrls.backdrop,
      ...artworkUrls.logos,
    ]) {
      if (await cache.match(artwork)) {
        title.files.push(artwork);
        continue;
      }
      await storeCounted(cache, artwork, options.signal, () => undefined)
        .then(() => title.files.push(artwork))
        .catch(() => undefined);
    }

    const countBytes = (bytes: number) => {
      title.downloadedBytes += bytes;
      report();
    };

    // Subtitles and seek thumbnails: small, and asked for during playback by
    // URLs that otherwise need the server. A track the server cannot convert
    // is left out rather than failing the whole title.
    // Each is kept where the offline player asks for it, taken from the
    // package's converted copy when there is one and extracted otherwise.
    for (const { streamIndex, url: packaged } of plan.subtitles ?? []) {
      const url = offlineSubtitleUrl(item.Id, streamIndex);
      const stored =
        (packaged !== undefined &&
          (await storeOptional(
            cache,
            url,
            options.signal,
            countBytes,
            absoluteUrl(ownApiUrl(packaged)),
          ))) ||
        (await storeOptional(cache, url, options.signal, countBytes));
      if (stored) {
        title.files.push(url);
        title.subtitleStreamIndexes!.push(streamIndex);
      }
    }
    const spriteCount = await trickplaySpriteCount(item.Id, options.signal);
    for (let sprite = 0; sprite < spriteCount; sprite += 1) {
      const url = absoluteUrl(getItemTrickplayImageUrl(item.Id, sprite));
      if (!(await storeOptional(cache, url, options.signal, countBytes))) break;
      title.files.push(url);
    }
    await saveOfflineTitle(title);

    for (const playlistUrl of playlistReferences(master, masterUrl)) {
      const playlist = await fetchText(playlistUrl, options.signal);
      await cache.put(
        playlistUrl,
        new Response(playlist, {
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        }),
      );
      title.files.push(playlistUrl);

      for (const resource of playlistReferences(playlist, playlistUrl)) {
        if (title.files.includes(resource)) continue;
        const stored = await cache.match(resource);
        if (
          stored &&
          stored.headers.get("Content-Type") !== PARTS_CONTENT_TYPE
        ) {
          // Stored whole by an earlier version, or small enough to be.
          const length = Number(stored.headers.get("Content-Length") ?? 0);
          title.downloadedBytes += length || (await stored.blob()).size;
          title.files.push(resource);
        } else {
          title.files.push(
            ...(await storeInParts(
              cache,
              resource,
              options.signal,
              countBytes,
            )),
          );
        }
        await saveOfflineTitle(title);
        report(true);
      }
    }

    title.state = "complete";
    title.updatedAt = new Date().toISOString();
    await saveOfflineTitle(title);
    report(true);
    return title;
  } catch (error) {
    title.state = "failed";
    title.updatedAt = new Date().toISOString();
    await saveOfflineTitle(title);
    report(true);
    throw error;
  }
}

/** Removes a title's stored copy and its record. */
export async function removeOfflineTitle(itemId: string): Promise<void> {
  const title = await getOfflineTitle(itemId);
  if (!title) return;
  const cache = await caches.open(OFFLINE_CACHE);
  const stillNeeded = new Set(
    (await listOfflineTitles())
      .filter((other) => other.itemId !== itemId)
      .flatMap((other) => other.files),
  );
  for (const url of title.files) {
    // Artwork can be shared: an episode's series backdrop, say.
    if (!stillNeeded.has(url)) await cache.delete(url);
  }
  await withStore("readwrite", (store) => store.delete(itemId));
  window.dispatchEvent(
    new CustomEvent("seyirlik:offline-changed", { detail: itemId }),
  );
}

/**
 * The stored item with only the tracks this copy carries, so the player never
 * offers an audio or subtitle track it cannot play offline.
 */
export function offlineItem(title: OfflineTitle): MediaItem {
  const keeps = (stream: MediaStream) => {
    if (stream.Type === "Audio") {
      return (
        !title.audioStreamIndexes ||
        title.audioStreamIndexes.includes(stream.Index ?? -1)
      );
    }
    if (stream.Type === "Subtitle") {
      return (title.subtitleStreamIndexes ?? []).includes(stream.Index ?? -1);
    }
    return true;
  };
  return {
    ...title.item,
    MediaSources: title.item.MediaSources?.map((source) => ({
      ...source,
      MediaStreams: source.MediaStreams?.filter(keeps),
    })),
  };
}

/**
 * A source that plays the stored copy through hls.js, with no session.
 *
 * Offline there is no server to open a session with or report progress to,
 * so the source carries only what the player needs to attach the stored
 * master, label it, and find the tracks and thumbnails stored beside it.
 */
export function offlinePlaybackSource(
  title: OfflineTitle,
): PlaybackSourceCandidate {
  const librarySource = offlineItem(title).MediaSources?.[0];
  return {
    id: `offline-${title.itemId}`,
    itemId: title.itemId,
    mediaSourceId: librarySource?.Id ?? title.itemId,
    mode: "DirectStream",
    url: title.masterUrl,
    mimeType: "application/vnd.apple.mpegurl",
    isHls: true,
    hlsKind: "direct",
    usingHlsJs: true,
    offline: true,
    label: `${title.height}p`,
    reason: "Stored on this device.",
    priority: 0,
    mediaSource: {
      Id: librarySource?.Id ?? title.itemId,
      Container: "hls",
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
      MediaStreams: librarySource?.MediaStreams ?? [],
    },
  } as PlaybackSourceCandidate;
}

/**
 * The item a player page shows: the stored snapshot on the offline route,
 * otherwise the server's, falling back to the snapshot when the server
 * cannot be reached.
 */
export async function loadPlayerItem(
  itemId: string,
  offlineOnly: boolean,
  fetchItem: (itemId: string) => Promise<MediaItem>,
): Promise<MediaItem> {
  if (offlineOnly) {
    const stored = await getOfflineTitle(itemId);
    if (!stored) throw new Error("This title is not downloaded.");
    return offlineItem(stored);
  }
  try {
    return await fetchItem(itemId);
  } catch (error) {
    const stored = await getOfflineTitle(itemId).catch(() => null);
    if (stored?.state === "complete") return offlineItem(stored);
    throw error;
  }
}
