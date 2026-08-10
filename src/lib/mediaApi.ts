import { ownApiClient, ownApiUrl } from "../api/ownApi/client";
import {
  toMediaItem,
  toMediaItems,
  toMediaLibrary,
  toMediaSource,
  ticksToMs,
} from "../api/ownApi/adapters";
import type {
  ChapterDto,
  HomeDto,
  ItemDto,
  ItemStreamsDto,
  LibraryDto,
  PlaybackSessionDto,
  SegmentDto,
  TaskDto,
} from "../api/ownApi/dto";
import { buildClientCapabilities } from "./playback-planner/clientCapabilities";
import type {
  MediaItem,
  MediaLibrary,
  MediaSource,
  MediaUser,
  MediaUserPolicy,
  MetadataRefreshOptions,
  NormalizedMediaSegment,
  PlaybackInfoResponse,
  PlaybackQualityOption,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
  ServerInfo,
} from "./types";

/**
 * The application's media API.
 *
 * Every call here reaches Seyirlik's own `/ownAPI/v1` surface. Identifiers are
 * opaque, durations cross the wire in milliseconds and are converted to ticks by
 * the adapter layer, and the session cookie is the only credential — there is no
 * access token in local storage and no server URL to configure.
 */

export const SERVER_UNAVAILABLE_EVENT = "seyirlik:server-unavailable";

/**
 * Emitted when the API cannot be reached. There is no server URL: Seyirlik now
 * talks to its own backend at the same origin, so the only useful diagnostics
 * are what the failed request reported.
 */
export interface ServerUnavailableEventDetail {
  reason?: string;
  status?: number;
  statusText?: string;
  code?: string;
  message?: string;
  requestUrl?: string;
}

export type ServerUnavailableEvent = CustomEvent<ServerUnavailableEventDetail>;

const TICKS_PER_SECOND = 10_000_000;

export function ticksFromSeconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

/**
 * Hides the session id in a playback URL while keeping the rest intact.
 *
 * A session id is a capability, so it must not reach a log or a diagnostics
 * panel — but the origin, path and remaining query are exactly what makes those
 * panels useful, so they are preserved.
 */
export function redactPlaybackUrl(playbackUrl: string): string {
  const redactSession = (value: string): string =>
    value.replace(
      /\/playback\/sessions\/[^/?#]+/g,
      "/playback/sessions/[redacted]",
    );

  try {
    return redactSession(new URL(playbackUrl, window.location.origin).toString());
  } catch {
    return redactSession(playbackUrl);
  }
}

// ---------------------------------------------------------------- artwork

function imageUrl(
  itemId: string,
  imageType: string,
  tag: string | undefined,
  maxWidth: number,
): string {
  const query = new URLSearchParams();
  // The content hash busts the browser cache when artwork is replaced; the
  // server validates with an ETag regardless.
  if (tag) query.set("tag", tag);
  if (maxWidth) query.set("maxWidth", String(maxWidth));
  const suffix = query.toString();
  return ownApiUrl(
    `/ownAPI/v1/items/${encodeURIComponent(itemId)}/images/${imageType}${
      suffix ? `?${suffix}` : ""
    }`,
  );
}

export function getPrimaryImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 500,
): string {
  return imageUrl(itemId, "primary", tag, maxWidth);
}

export function getBackdropImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 1600,
): string {
  return imageUrl(itemId, "backdrop", tag, maxWidth);
}

export function getLogoImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 900,
): string {
  return imageUrl(itemId, "logo", tag, maxWidth);
}

export function getThumbImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 900,
): string {
  return imageUrl(itemId, "thumb", tag, maxWidth);
}

// -------------------------------------------------------------- catalogue

export async function testServerConnection(
  // Kept for call-site compatibility during the cutover; Seyirlik serves its own
  // API from the page's origin, so there is no server URL to test against.
  _serverUrl?: string,
): Promise<ServerInfo> {
  const health = await ownApiClient.getHealth();
  return {
    ProductName: "Seyirlik",
    ServerName: "Seyirlik",
    Version: health.ready ? "ready" : "starting",
  };
}

export async function getUserViews(): Promise<MediaLibrary[]> {
  const libraries = await ownApiClient.request<LibraryDto[]>("/libraries");
  return libraries.map(toMediaLibrary);
}

/** Drains a cursor-paginated collection into a single list. */
async function collectAll(
  path: string,
  searchParams: Record<string, string> = {},
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ limit: "200", ...searchParams });
    if (cursor) query.set("cursor", cursor);

    const page = await ownApiClient.requestCollection<ItemDto>(
      `${path}?${query.toString()}`,
    );
    items.push(...toMediaItems(page.data));
    cursor = page.pagination?.nextCursor ?? null;
  } while (cursor);

  return items;
}

export async function getItem(itemId: string): Promise<MediaItem> {
  return toMediaItem(
    await ownApiClient.request<ItemDto>(`/items/${encodeURIComponent(itemId)}`),
  );
}

export async function getItemsForLibrary(
  libraryId: string,
): Promise<MediaItem[]> {
  return collectAll(`/libraries/${encodeURIComponent(libraryId)}/items`);
}

export async function getTopLevelItemsForLibrary(
  libraryId: string,
  // The native library endpoint already returns the top-level kinds, so the
  // collection type the caller passes is no longer needed to choose a query.
  _collectionType?: string,
): Promise<MediaItem[]> {
  return getItemsForLibrary(libraryId);
}

export async function getVideoItemsForLibrary(
  libraryId: string,
): Promise<MediaItem[]> {
  return getItemsForLibrary(libraryId);
}

export async function getAllMovieItems(): Promise<MediaItem[]> {
  return collectAll("/movies");
}

export async function getAllSeriesItems(): Promise<MediaItem[]> {
  return collectAll("/series");
}

export async function getAllMovieAndSeriesItems(): Promise<MediaItem[]> {
  const [movies, series] = await Promise.all([
    getAllMovieItems(),
    getAllSeriesItems(),
  ]);
  return [...movies, ...series];
}

export async function getAllVideoItems(): Promise<MediaItem[]> {
  return getAllMovieAndSeriesItems();
}

export async function getAllContentItems(): Promise<MediaItem[]> {
  const [movies, series, collections] = await Promise.all([
    getAllMovieItems(),
    getAllSeriesItems(),
    getAllBoxSetItems(),
  ]);
  return [...movies, ...series, ...collections];
}

export async function getAllBoxSetItems(): Promise<MediaItem[]> {
  return collectAll("/collections");
}

export async function getBoxSetItems(boxSetId: string): Promise<MediaItem[]> {
  return collectAll(`/libraries/${encodeURIComponent(boxSetId)}/items`);
}

export async function getSeriesSeasons(seriesId: string): Promise<MediaItem[]> {
  const seasons = await ownApiClient.request<ItemDto[]>(
    `/series/${encodeURIComponent(seriesId)}/seasons`,
  );
  return toMediaItems(seasons);
}

export async function getSeasonEpisodes(
  _seriesId: string,
  seasonId: string,
): Promise<MediaItem[]> {
  const episodes = await ownApiClient.request<ItemDto[]>(
    `/seasons/${encodeURIComponent(seasonId)}/episodes`,
  );
  return toMediaItems(episodes);
}

export async function getAllSeriesEpisodes(
  seriesId: string,
): Promise<MediaItem[]> {
  const episodes = await ownApiClient.request<ItemDto[]>(
    `/series/${encodeURIComponent(seriesId)}/episodes`,
  );
  return toMediaItems(episodes);
}

export async function getNextEpisodeInSeason(
  currentEpisode: MediaItem,
): Promise<MediaItem | null> {
  const next = await ownApiClient.request<ItemDto | null>(
    `/episodes/${encodeURIComponent(currentEpisode.Id)}/next`,
  );
  return next ? toMediaItem(next) : null;
}

export async function getLocalTrailers(itemId: string): Promise<MediaItem[]> {
  const trailers = await ownApiClient.request<ItemDto[]>(
    `/items/${encodeURIComponent(itemId)}/trailers`,
  );
  return toMediaItems(trailers);
}

export async function getSimilarItems(
  itemId: string,
  limit = 18,
): Promise<MediaItem[]> {
  const item = await getItem(itemId);
  const genre = item.Genres?.[0];
  if (!genre) return [];

  // Similarity is genre-based rather than provider-supplied, so a title stays
  // discoverable even when it was never matched against a provider.
  const page = await ownApiClient.requestCollection<ItemDto>(
    `/movies?limit=${limit + 1}&genre=${encodeURIComponent(genre)}`,
  );
  return toMediaItems(page.data).filter((candidate) => candidate.Id !== itemId);
}

export async function getLatestMediaItems(): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    "/home/latest?limit=40",
  );
  return toMediaItems(page.data);
}

export async function getContinueWatchingItems(): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    "/home/continue-watching?limit=40",
  );
  return toMediaItems(page.data);
}

export async function getNextUpEpisodes(): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    "/home/next-up?limit=40",
  );
  return toMediaItems(page.data);
}

export async function getHome(): Promise<HomeDto> {
  return ownApiClient.request<HomeDto>("/home");
}

export async function searchItems(query: string): Promise<MediaItem[]> {
  const page = await ownApiClient.requestCollection<ItemDto>(
    `/search?q=${encodeURIComponent(query)}`,
  );
  return toMediaItems(page.data);
}

// ------------------------------------------------------------- user state

export async function markItemPlayed(itemId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/items/${encodeURIComponent(itemId)}/played`,
    { method: "POST" },
  );
}

export async function markItemUnplayed(itemId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/items/${encodeURIComponent(itemId)}/played`,
    { method: "DELETE" },
  );
}

/** Clears progress for an item and everything beneath it in one request. */
export async function resetItemWatchedStatus(itemId: string): Promise<void> {
  await ownApiClient.request<{ affected: number }>(
    `/items/${encodeURIComponent(itemId)}/watched/reset`,
    { method: "POST", body: {} },
  );
}

/** Marks an item and everything beneath it watched in one request. */
export async function markItemWatchedStatus(itemId: string): Promise<void> {
  await ownApiClient.request<{ affected: number }>(
    `/items/${encodeURIComponent(itemId)}/watched/mark`,
    { method: "POST", body: {} },
  );
}

export async function setItemFavourite(
  itemId: string,
  isFavourite: boolean,
): Promise<void> {
  await ownApiClient.request<void>(
    `/favourites/${encodeURIComponent(itemId)}`,
    { method: isFavourite ? "POST" : "DELETE" },
  );
}

/**
 * Progress writes carry a monotonic sequence so a delayed retry from a
 * backgrounded tab can never rewind a position the user has since passed.
 */
let progressSequence = 0;

async function writeProgress(
  itemId: string,
  positionTicks: number,
): Promise<void> {
  progressSequence += 1;
  try {
    await ownApiClient.request<unknown>(
      `/progress/${encodeURIComponent(itemId)}`,
      {
        method: "PUT",
        body: {
          positionMs: ticksToMs(positionTicks),
          sequence: progressSequence,
        },
      },
    );
  } catch (error) {
    // A rejected stale write is expected during normal playback and must not
    // surface as a player error.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "PROGRESS_STALE"
    ) {
      return;
    }
    throw error;
  }
}

export async function reportPlaybackStart(
  source: PlaybackSourceCandidate,
  positionTicks = 0,
): Promise<void> {
  await writeProgress(source.itemId, positionTicks);
}

export async function reportPlaybackProgress(
  source: PlaybackSourceCandidate,
  positionTicks: number,
  // Pause state is not part of native progress: the resume position is what
  // matters, and the player already knows whether it is paused.
  _isPaused?: boolean,
): Promise<void> {
  await writeProgress(source.itemId, positionTicks);
}

export async function reportPlaybackStopped(
  source: PlaybackSourceCandidate,
  positionTicks: number,
): Promise<void> {
  await writeProgress(source.itemId, positionTicks);
  await stopActiveTranscodeSession(source.playSessionId);
}

/**
 * Fired from `pagehide`/`beforeunload`, where a normal request is cancelled.
 * `sendBeacon` is the only transport the browser guarantees to flush.
 */
export function reportPlaybackStoppedBeforeUnload(
  source: PlaybackSourceCandidate,
  positionTicks: number,
): void {
  if (typeof navigator === "undefined" || !navigator.sendBeacon) return;

  progressSequence += 1;
  const payload = JSON.stringify({
    positionMs: ticksToMs(positionTicks),
    sequence: progressSequence,
  });
  navigator.sendBeacon(
    ownApiUrl(`/ownAPI/v1/progress/${encodeURIComponent(source.itemId)}`),
    new Blob([payload], { type: "application/json" }),
  );
}

// Audit reporting used to be a separate Jellyfin session channel. Native
// progress already records everything the audit page reads, so these remain as
// no-ops to keep the player's call sites unchanged.
export async function reportAuditPlaybackStart(
  _source?: PlaybackSourceCandidate,
): Promise<void> {}
export async function reportAuditPlaybackProgress(
  _source?: PlaybackSourceCandidate,
): Promise<void> {}
export async function reportAuditPlaybackStopped(
  _source?: PlaybackSourceCandidate,
): Promise<void> {}

// --------------------------------------------------------------- playback

export async function getMediaSegments(
  itemId: string,
): Promise<NormalizedMediaSegment[]> {
  const segments = await ownApiClient.request<SegmentDto[]>(
    `/items/${encodeURIComponent(itemId)}/segments`,
  );
  return segments.map((segment) => ({
    id: segment.id,
    type: segment.type,
    startSeconds: segment.startMs / 1_000,
    endSeconds: segment.endMs / 1_000,
  }));
}

export async function getChapters(itemId: string): Promise<ChapterDto[]> {
  return ownApiClient.request<ChapterDto[]>(
    `/items/${encodeURIComponent(itemId)}/chapters`,
  );
}

/**
 * Creates a playback session and adapts it to the response shape the player
 * already consumes.
 */
export async function getPlaybackInfo(
  itemId: string,
  settings: PlaybackSourceSettings = {},
): Promise<PlaybackInfoResponse> {
  const capabilities = await buildClientCapabilities();
  const session = await ownApiClient.request<PlaybackSessionDto>(
    "/playback/sessions",
    {
      method: "POST",
      body: {
        itemId,
        clientCapabilities: capabilities,
        ...(settings.audioStreamIndex === undefined
          ? {}
          : { audioStreamIndex: settings.audioStreamIndex }),
        ...(settings.maxHeight === undefined
          ? {}
          : { maxHeight: settings.maxHeight }),
        ...(settings.maxStreamingBitrate === undefined
          ? {}
          : { maxBitrateBps: settings.maxStreamingBitrate }),
      },
    },
  );

  const streams = await ownApiClient.request<ItemStreamsDto>(
    `/items/${encodeURIComponent(itemId)}/streams`,
  );
  const primary =
    streams.sources.find((source) => source.id === session.mediaFileId) ??
    streams.sources[0];

  const mediaSource: MediaSource = {
    ...(primary ? toMediaSource(primary) : { Id: session.mediaFileId }),
    SupportsDirectPlay: session.plan.mode === "DIRECT_PLAY",
    SupportsDirectStream: session.plan.mode !== "TRANSCODE",
    SupportsTranscoding: true,
    TranscodingReasons: session.plan.reasonCodes,
    ...(session.delivery.type === "hls"
      ? {
          TranscodingUrl: ownApiUrl(session.delivery.url),
          TranscodingSubProtocol: "hls",
        }
      : { DirectStreamUrl: ownApiUrl(session.delivery.url) }),
  };

  return {
    MediaSources: [mediaSource],
    PlaySessionId: session.sessionId,
  };
}

export function buildPlaybackCandidates(
  itemId: string,
  playbackInfo: PlaybackInfoResponse,
): PlaybackSourceCandidate[] {
  const mediaSource = playbackInfo.MediaSources?.[0];
  if (!mediaSource) return [];

  const isHls = Boolean(mediaSource.TranscodingUrl);
  const url = mediaSource.TranscodingUrl ?? mediaSource.DirectStreamUrl ?? "";
  const mode = mediaSource.SupportsDirectPlay
    ? "DirectPlay"
    : mediaSource.SupportsDirectStream
      ? "DirectStream"
      : "Transcoding";

  return [
    {
      id: `${itemId}-native`,
      itemId,
      ...(mediaSource.Id ? { mediaSourceId: mediaSource.Id } : {}),
      ...(playbackInfo.PlaySessionId
        ? { playSessionId: playbackInfo.PlaySessionId }
        : {}),
      mode,
      url,
      isHls,
      ...(isHls ? { hlsKind: "forced-transcode" as const, usingHlsJs: true } : {}),
      ...(isHls
        ? { mimeType: "application/vnd.apple.mpegurl" }
        : mediaSource.Container
          ? { mimeType: `video/${mediaSource.Container}` }
          : {}),
      label: isHls ? "Adaptive stream" : "Original file",
      mediaSource,
      playbackInfo,
      reason: isHls
        ? "The server is repackaging this title for your browser."
        : "Your browser can play this file directly.",
      ...(mediaSource.TranscodingReasons
        ? { transcodeReasons: mediaSource.TranscodingReasons }
        : {}),
      priority: 0,
    },
  ];
}

/**
 * Re-plans the same item under an explicit quality ceiling. Native playback
 * changes quality by creating a new session, so unlike the URL-rewriting this
 * replaces, it is asynchronous.
 */
export async function buildConfiguredHlsPlaybackSource(
  source: PlaybackSourceCandidate,
  settings: PlaybackSourceSettings,
  label = "Custom quality",
): Promise<PlaybackSourceCandidate | null> {
  const playbackInfo = await getPlaybackInfo(source.itemId, settings);
  const [candidate] = buildPlaybackCandidates(source.itemId, playbackInfo);
  return candidate ? { ...candidate, label } : null;
}

const QUALITY_LADDER: Array<{ height: number; label: string; bitrate: number }> = [
  { height: 2160, label: "4K", bitrate: 60_000_000 },
  { height: 1080, label: "1080p", bitrate: 12_000_000 },
  { height: 720, label: "720p", bitrate: 6_000_000 },
  { height: 480, label: "480p", bitrate: 3_000_000 },
];

export function getManualQualityOptions(
  mediaSource: MediaSource,
): PlaybackQualityOption[] {
  const video = mediaSource.MediaStreams?.find(
    (stream) => stream.Type === "Video",
  );
  const sourceHeight = video?.Height ?? 1080;

  // Never offer a rung above the source: upscaling costs a transcode and gains
  // nothing.
  return QUALITY_LADDER.filter((rung) => rung.height <= sourceHeight).map(
    (rung) => ({
      id: `h${rung.height}`,
      label: rung.label,
      subtitle: `${Math.round(rung.bitrate / 1_000_000)} Mbps`,
      maxHeight: rung.height,
      maxStreamingBitrate: rung.bitrate,
    }),
  );
}

export function buildSubtitleStreamUrl(
  sessionId: string,
  subtitleStreamIndex: number,
): string {
  return ownApiUrl(
    `/ownAPI/v1/playback/sessions/${encodeURIComponent(
      sessionId,
    )}/subtitles/${subtitleStreamIndex}.vtt`,
  );
}

export function getItemFileUrl(sessionId: string): string {
  return ownApiUrl(
    `/ownAPI/v1/playback/sessions/${encodeURIComponent(sessionId)}/file`,
  );
}

export function getItemDownloadUrl(sessionId: string): string {
  return getItemFileUrl(sessionId);
}

export async function getHeroPreviewUrl(
  _item?: MediaItem,
): Promise<string | null> {
  // Hero preview clips are not part of the native catalogue yet; the hero falls
  // back to its backdrop rather than silently playing the feature.
  return null;
}

export async function stopActiveTranscodeSession(
  playSessionId?: string,
): Promise<void> {
  if (!playSessionId) return;
  await ownApiClient
    .request<void>(
      `/playback/sessions/${encodeURIComponent(playSessionId)}`,
      { method: "DELETE" },
    )
    .catch(() => undefined);
}

export async function getActiveTranscodingReasons(
  _itemId: string,
  playSessionId?: string,
): Promise<string[]> {
  if (!playSessionId) return [];
  try {
    const session = await ownApiClient.request<{ reasonCodes: string[] }>(
      `/playback/sessions/${encodeURIComponent(playSessionId)}`,
    );
    return session.reasonCodes;
  } catch {
    return [];
  }
}

// -------------------------------------------------------------- trickplay

export interface TrickplayInfo {
  setId: string;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  intervalMs: number;
  thumbnailCount: number;
  spriteCount: number;
}

export async function getTrickplayInfo(
  itemId: string,
): Promise<TrickplayInfo | null> {
  try {
    return await ownApiClient.request<TrickplayInfo>(
      `/items/${encodeURIComponent(itemId)}/trickplay`,
    );
  } catch {
    return null;
  }
}

export function getTrickplayImageUrl(
  setId: string,
  spriteIndex: number,
): string {
  return ownApiUrl(
    `/ownAPI/v1/trickplay/${encodeURIComponent(setId)}/sprites/${spriteIndex}`,
  );
}

/**
 * Sprite URL addressed by item rather than by set. The seek bar knows an item,
 * and this URL stays valid when sheets are regenerated under a new set id.
 */
export function getItemTrickplayImageUrl(
  itemId: string,
  spriteIndex: number,
): string {
  return ownApiUrl(
    `/ownAPI/v1/items/${encodeURIComponent(itemId)}/trickplay/sprites/${spriteIndex}`,
  );
}

// ------------------------------------------------------------------ admin

export async function getUsers(): Promise<MediaUser[]> {
  const users = await ownApiClient.request<
    Array<{
      id: string;
      username: string;
      displayName: string;
      isAdministrator: boolean;
      isDisabled: boolean;
      lastLoginAt: string | null;
    }>
  >("/admin/users");

  return users.map((user) => ({
    Id: user.id,
    Name: user.displayName,
    HasPassword: true,
    ...(user.lastLoginAt ? { LastLoginDate: user.lastLoginAt } : {}),
    Policy: {
      IsAdministrator: user.isAdministrator,
      IsDisabled: user.isDisabled,
    },
  }));
}

export async function getUserById(userId: string): Promise<MediaUser> {
  const users = await getUsers();
  const user = users.find((candidate) => candidate.Id === userId);
  if (!user) throw new Error("The requested user could not be found.");
  return user;
}

export async function createUser(
  name: string,
  password: string,
): Promise<MediaUser> {
  const created = await ownApiClient.request<{
    id: string;
    displayName: string;
  }>("/admin/users", {
    method: "POST",
    body: { username: name, password, displayName: name },
  });

  return { Id: created.id, Name: created.displayName, HasPassword: true };
}

export async function updateUser(user: MediaUser): Promise<void> {
  await ownApiClient.request<unknown>(
    `/admin/users/${encodeURIComponent(user.Id)}`,
    { method: "PATCH", body: { displayName: user.Name } },
  );
}

export async function updateUserPolicy(
  userId: string,
  policy: MediaUserPolicy,
): Promise<void> {
  await ownApiClient.request<unknown>(
    `/admin/users/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      body: {
        ...(policy.IsAdministrator === undefined
          ? {}
          : { isAdministrator: policy.IsAdministrator }),
        ...(policy.IsDisabled === undefined
          ? {}
          : { isDisabled: policy.IsDisabled }),
        ...(policy.EnableMediaPlayback === undefined
          ? {}
          : { allowPlayback: policy.EnableMediaPlayback }),
        ...(policy.EnableContentDownloading === undefined
          ? {}
          : { allowDownloads: policy.EnableContentDownloading }),
        ...(policy.EnableAllFolders === undefined
          ? {}
          : { allowAllLibraries: policy.EnableAllFolders }),
      },
    },
  );
}

export async function updateUserPassword(
  userId: string,
  options: { newPassword: string; resetPassword?: boolean },
): Promise<void> {
  await ownApiClient.request<void>(
    `/admin/users/${encodeURIComponent(userId)}/password`,
    { method: "PUT", body: { password: options.newPassword } },
  );
}

export async function deleteUser(userId: string): Promise<void> {
  await ownApiClient.request<void>(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

export async function scanAllLibraries(): Promise<void> {
  await ownApiClient.request<{ taskIds: string[] }>(
    "/admin/libraries/scan-all",
    { method: "POST", body: {} },
  );
}

export async function scanLibrary(libraryId: string): Promise<string> {
  const task = await ownApiClient.request<{ taskId: string }>(
    `/admin/libraries/${encodeURIComponent(libraryId)}/scan`,
    { method: "POST", body: {} },
  );
  return task.taskId;
}

export async function refreshLibraryMetadata(
  libraryId: string,
): Promise<void> {
  await ownApiClient.request<{ taskId: string }>(
    `/admin/metadata/refresh?libraryId=${encodeURIComponent(libraryId)}`,
    { method: "POST", body: {} },
  );
}

export async function refreshItemMetadata(
  itemId: string,
  _options: MetadataRefreshOptions = {},
): Promise<void> {
  await ownApiClient.request<{ taskId: string }>(
    `/admin/items/${encodeURIComponent(itemId)}/metadata/refresh`,
    { method: "POST", body: {} },
  );
}

export async function updateItemMetadata(
  itemId: string,
  item: MediaItem,
): Promise<void> {
  await ownApiClient.request<unknown>(
    `/admin/items/${encodeURIComponent(itemId)}/metadata`,
    {
      method: "PATCH",
      body: {
        ...(item.Name ? { title: item.Name } : {}),
        ...(item.OriginalTitle ? { originalTitle: item.OriginalTitle } : {}),
        ...(item.Overview ? { overview: item.Overview } : {}),
        ...(item.Taglines?.[0] ? { tagline: item.Taglines[0] } : {}),
        ...(item.OfficialRating
          ? { officialRating: item.OfficialRating }
          : {}),
      },
    },
  );
}

export async function getTasks(): Promise<TaskDto[]> {
  return ownApiClient.request<TaskDto[]>("/admin/tasks");
}
