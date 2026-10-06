import { ownApiClient, ownApiUrl } from "../../api/ownApi/client";
import { getBackdropImageUrl, getPrimaryImageUrl } from "../mediaApi";
import type { MediaItem, PlaybackSourceCandidate } from "../types";
import {
  isMultivariantPlaylist,
  keepDefaultAudioOnly,
  playlistReferences,
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
}

/**
 * The artwork URLs a download stores, which the Downloads page must request
 * exactly — the service worker matches on the whole URL, query included.
 */
export function offlineArtworkUrls(item: MediaItem): {
  poster: string;
  backdrop: string;
} {
  const absolute = (url: string) =>
    typeof window === "undefined"
      ? url
      : new URL(url, window.location.href).toString();
  return {
    poster: absolute(getPrimaryImageUrl(item.Id, item.ImageTags?.Primary, 400)),
    backdrop: absolute(
      getBackdropImageUrl(item.Id, item.BackdropImageTags?.[0], 1280),
    ),
  };
}

export function isOfflineSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "caches" in window &&
    "indexedDB" in window &&
    "serviceWorker" in navigator
  );
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
    new Response(
      JSON.stringify({ size, partBytes: PART_BYTES, contentType }),
      { headers: { "Content-Type": PARTS_CONTENT_TYPE } },
    ),
  );
  files.push(url);
  return files;
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
    // Video plus a stereo AAC track, which is the part a bitrate leaves out.
    estimatedBytes: Math.round(
      (durationSeconds * (quality.bitrate + 192_000)) / 8,
    ),
    state: "downloading",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
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
    const master = keepDefaultAudioOnly(
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

    // Artwork, so the Downloads page is not a list of grey boxes offline.
    for (const artwork of [
      offlineArtworkUrls(item).poster,
      offlineArtworkUrls(item).backdrop,
    ]) {
      if (await cache.match(artwork)) {
        title.files.push(artwork);
        continue;
      }
      await storeCounted(cache, artwork, options.signal, () => undefined)
        .then(() => title.files.push(artwork))
        .catch(() => undefined);
    }

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
              (bytes) => {
                title.downloadedBytes += bytes;
                report();
              },
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
 * A source that plays the stored copy through hls.js, with no session.
 *
 * Offline there is no server to open a session with, report progress to or
 * ask for subtitles, so the source carries only what the player needs to
 * attach the stored master and label it.
 */
export function offlinePlaybackSource(
  title: OfflineTitle,
): PlaybackSourceCandidate {
  return {
    id: `offline-${title.itemId}`,
    itemId: title.itemId,
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
      Id: title.itemId,
      Container: "hls",
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: false,
      MediaStreams: title.item.MediaSources?.[0]?.MediaStreams ?? [],
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
    return stored.item;
  }
  try {
    return await fetchItem(itemId);
  } catch (error) {
    const stored = await getOfflineTitle(itemId).catch(() => null);
    if (stored?.state === "complete") return stored.item;
    throw error;
  }
}
