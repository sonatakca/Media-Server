import {
  createJellyfinAuthorizationHeader,
  getAuthHeaders,
  getAuthSession,
  getServerUrl,
  normalizeServerUrl,
} from "./authStorage";
import type {
  JellyfinAuthResponse,
  JellyfinItem,
  JellyfinItemsResponse,
  JellyfinLibrary,
  JellyfinMediaSource,
  JellyfinMediaStream,
  JellyfinPlaybackInfoResponse,
  JellyfinPublicSystemInfo,
  PlaybackQualityOption,
  PlaybackMode,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
} from "./types";

type QueryValue = string | number | boolean | null | undefined | Array<string | number | boolean>;

type QueryParams = Record<string, QueryValue>;

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  params?: QueryParams;
  auth?: boolean;
  deviceAuth?: boolean;
  serverUrlOverride?: string;
}

const DEFAULT_ITEM_FIELDS = [
  "PrimaryImageAspectRatio",
  "SortName",
  "Overview",
  "Genres",
  "RunTimeTicks",
  "ProductionYear",
  "ChildCount",
  "RecursiveItemCount",
  "MediaSources",
  "UserData",
  "ImageTags",
  "BackdropImageTags",
  "ParentLogoItemId",
  "ParentLogoImageTag",
  "ParentId",
  "SeriesId",
  "SeasonId",
  "SeriesName",
  "SeasonName",
].join(",");

const MAX_STREAMING_BITRATE = 120_000_000;

function appendQueryParams(url: URL, params: QueryParams = {}): void {
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "") {
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > 0) {
        url.searchParams.set(key, value.join(","));
      }
      return;
    }

    url.searchParams.set(key, String(value));
  });
}

export function buildJellyfinUrl(serverUrl: string, path: string, params: QueryParams = {}): string {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  const normalizedPath = path.replace(/^\/+/, "");
  const url = new URL(`${normalizedServerUrl}/${normalizedPath}`);
  appendQueryParams(url, params);
  return url.toString();
}

function appendAuthTokenToMediaUrl(mediaUrl: string, token: string): string {
  const url = new URL(mediaUrl);

  // Media elements cannot send X-Emby-Token headers. Jellyfin accepts api_key on
  // image and video URLs, so playable URLs carry the token as a query parameter.
  if (!url.searchParams.has("api_key")) {
    url.searchParams.set("api_key", token);
  }

  return url.toString();
}

function makePlaybackUrlAbsolute(urlOrPath: string, serverUrl: string, token: string): string {
  const normalizedServerUrl = normalizeServerUrl(serverUrl);
  let absoluteUrl: string;

  if (urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://")) {
    absoluteUrl = urlOrPath;
  } else if (urlOrPath.startsWith("/")) {
    const server = new URL(normalizedServerUrl);
    const basePath = server.pathname.replace(/\/+$/, "");
    absoluteUrl =
      basePath && urlOrPath.startsWith(`${basePath}/`)
        ? `${server.origin}${urlOrPath}`
        : `${normalizedServerUrl}${urlOrPath}`;
  } else {
    absoluteUrl = `${normalizedServerUrl}/${urlOrPath}`;
  }

  return appendAuthTokenToMediaUrl(absoluteUrl, token);
}

export function redactPlaybackUrl(playbackUrl: string): string {
  try {
    const url = new URL(playbackUrl);

    for (const key of ["api_key", "access_token", "X-Emby-Token"]) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "REDACTED");
      }
    }

    return url.toString();
  } catch {
    return playbackUrl.replace(/(api_key|access_token)=([^&]+)/gi, "$1=REDACTED");
  }
}

async function parseErrorMessage(response: Response): Promise<string> {
  const fallback = `Jellyfin request failed with ${response.status} ${response.statusText}.`;

  try {
    const text = await response.text();

    if (!text) {
      return fallback;
    }

    try {
      const json = JSON.parse(text) as { message?: string; Message?: string; error?: string };
      return json.message || json.Message || json.error || text;
    } catch {
      return text;
    }
  } catch {
    return fallback;
  }
}

function requireAuthSession() {
  const session = getAuthSession();

  if (!session?.accessToken) {
    throw new Error("Missing Jellyfin access token. Please sign in again.");
  }

  return session;
}

async function requestJson<TResponse>(
  path: string,
  {
    method = "GET",
    body,
    params,
    auth = true,
    deviceAuth = false,
    serverUrlOverride,
  }: RequestOptions = {},
): Promise<TResponse> {
  const serverUrl = serverUrlOverride ? normalizeServerUrl(serverUrlOverride) : getServerUrl();

  if (!serverUrl) {
    throw new Error("Missing Jellyfin server URL.");
  }

  const url = buildJellyfinUrl(serverUrl, path, params);
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (auth) {
    const authHeaders = getAuthHeaders();

    if (!authHeaders["X-Emby-Token"]) {
      throw new Error("Missing Jellyfin access token. Please sign in again.");
    }

    Object.assign(headers, authHeaders);
  } else if (deviceAuth) {
    const deviceAuthorization = createJellyfinAuthorizationHeader();
    headers.Authorization = deviceAuthorization;
    headers["X-Emby-Authorization"] = deviceAuthorization;
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as TResponse;
}

export async function testServerConnection(serverUrl: string): Promise<JellyfinPublicSystemInfo> {
  return requestJson<JellyfinPublicSystemInfo>("/System/Info/Public", {
    auth: false,
    serverUrlOverride: serverUrl,
  });
}

export async function authenticateByName(
  username: string,
  password: string,
): Promise<JellyfinAuthResponse> {
  return requestJson<JellyfinAuthResponse>("/Users/AuthenticateByName", {
    method: "POST",
    auth: false,
    deviceAuth: true,
    body: {
      Username: username,
      Pw: password,
    },
  });
}

export async function getUserViews(): Promise<JellyfinLibrary[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinLibrary>>("/UserViews", {
    params: {
      userId: session.userId,
      includeExternalContent: false,
      includeHidden: false,
    },
  });

  return response.Items ?? [];
}

export async function getItemsForLibrary(libraryId: string): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>("/Items", {
    params: {
      userId: session.userId,
      parentId: libraryId,
      recursive: false,
      sortBy: "SortName",
      sortOrder: "Ascending",
      fields: DEFAULT_ITEM_FIELDS,
      enableImages: true,
      imageTypeLimit: 1,
      enableImageTypes: "Primary,Backdrop,Logo",
    },
  });

  return response.Items ?? [];
}

export async function getTopLevelItemsForLibrary(libraryId: string, collectionType?: string): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const includeItemTypes =
    collectionType === "tvshows"
      ? "Series"
      : collectionType === "movies"
        ? "Movie"
        : undefined;

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>("/Items", {
    params: {
      userId: session.userId,
      parentId: libraryId,
      recursive: false,
      includeItemTypes,
      sortBy: "SortName",
      sortOrder: "Ascending",
      fields: DEFAULT_ITEM_FIELDS,
      enableImages: true,
      imageTypeLimit: 1,
      enableImageTypes: "Primary,Backdrop,Logo",
    },
  });

  return response.Items ?? [];
}

export async function getSeriesSeasons(seriesId: string): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>("/Shows/Seasons", {
    params: {
      userId: session.userId,
      seriesId,
      fields: DEFAULT_ITEM_FIELDS,
      enableImages: true,
      imageTypeLimit: 1,
      enableImageTypes: "Primary,Backdrop,Logo",
    },
  });

  return response.Items ?? [];
}

export async function getSeasonEpisodes(seriesId: string, seasonId: string): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>("/Shows/Episodes", {
    params: {
      userId: session.userId,
      seriesId,
      seasonId,
      fields: DEFAULT_ITEM_FIELDS,
      enableImages: true,
      imageTypeLimit: 1,
      enableImageTypes: "Primary,Backdrop,Logo",
    },
  });

  return response.Items ?? [];
}

export async function getItem(itemId: string): Promise<JellyfinItem> {
  const session = requireAuthSession();

  const params = {
    userId: session.userId,
    fields: DEFAULT_ITEM_FIELDS,
    enableImages: true,
    imageTypeLimit: 1,
    enableImageTypes: "Primary,Backdrop,Logo",
  };

  try {
    return await requestJson<JellyfinItem>(`/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(itemId)}`, {
      params,
    });
  } catch (userScopedError) {
    try {
      return await requestJson<JellyfinItem>(`/Items/${encodeURIComponent(itemId)}`, {
        params,
      });
    } catch {
      throw userScopedError;
    }
  }
}

export async function getContinueWatchingItems(): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>("/UserItems/Resume", {
    params: {
      userId: session.userId,
      limit: 20,
      mediaTypes: "Video",
      fields: DEFAULT_ITEM_FIELDS,
      enableImages: true,
      imageTypeLimit: 1,
      enableImageTypes: "Primary,Backdrop,Logo",
      enableUserData: true,
      excludeActiveSessions: false,
    },
  });

  return response.Items ?? [];
}

export async function getLatestMediaItems(): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  return requestJson<JellyfinItem[]>("/Items/Latest", {
    params: {
      userId: session.userId,
      limit: 24,
      fields: DEFAULT_ITEM_FIELDS,
      includeItemTypes: "Movie,Series",
      enableImages: true,
      imageTypeLimit: 1,
      enableImageTypes: "Primary,Backdrop,Logo",
      enableUserData: true,
      groupItems: false,
    },
  });
}

function getBrowserDeviceProfile(): Record<string, unknown> {
  return {
    Name: "Seyirlik Web HTML5",
    MaxStreamingBitrate: MAX_STREAMING_BITRATE,
    MaxStaticBitrate: MAX_STREAMING_BITRATE,
    MusicStreamingTranscodingBitrate: 384_000,
    DirectPlayProfiles: [
      {
        Type: "Video",
        Container: "mp4,m4v,mov",
        VideoCodec: "h264,av1,hevc",
        AudioCodec: "aac,mp3,ac3,eac3",
      },
      {
        Type: "Video",
        Container: "webm",
        VideoCodec: "vp8,vp9,av1",
        AudioCodec: "vorbis,opus",
      },
      {
        Type: "Audio",
        Container: "mp3,aac,m4a,flac,webma,webm",
      },
    ],
    TranscodingProfiles: [
      {
        Type: "Video",
        Container: "ts",
        Protocol: "hls",
        VideoCodec: "h264",
        AudioCodec: "aac",
        Context: "Streaming",
        TranscodeSeekInfo: "Auto",
        CopyTimestamps: false,
        EnableSubtitlesInManifest: true,
        MaxAudioChannels: "6",
        MinSegments: 1,
        SegmentLength: 6,
        BreakOnNonKeyFrames: true,
      },
      {
        Type: "Video",
        Container: "mp4",
        Protocol: "http",
        VideoCodec: "h264",
        AudioCodec: "aac",
        Context: "Streaming",
        TranscodeSeekInfo: "Auto",
        CopyTimestamps: false,
        MaxAudioChannels: "6",
      },
    ],
    SubtitleProfiles: [
      { Format: "vtt", Method: "External" },
      { Format: "srt", Method: "External" },
      { Format: "ass", Method: "External" },
      { Format: "ssa", Method: "External" },
    ],
  };
}

export async function getPlaybackInfo(itemId: string): Promise<JellyfinPlaybackInfoResponse> {
  const session = requireAuthSession();

  return requestJson<JellyfinPlaybackInfoResponse>(`/Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
    method: "POST",
    params: {
      userId: session.userId,
      maxStreamingBitrate: MAX_STREAMING_BITRATE,
      autoOpenLiveStream: true,
      enableDirectPlay: true,
      enableDirectStream: true,
      enableTranscoding: true,
      allowVideoStreamCopy: true,
      allowAudioStreamCopy: true,
    },
    body: {
      UserId: session.userId,
      DeviceProfile: getBrowserDeviceProfile(),
      MaxStreamingBitrate: MAX_STREAMING_BITRATE,
      EnableDirectPlay: true,
      EnableDirectStream: true,
      EnableTranscoding: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      AutoOpenLiveStream: true,
    },
  });
}

function getMediaStream(mediaSource: JellyfinMediaSource, type: "Video" | "Audio"): JellyfinMediaStream | undefined {
  return mediaSource.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === type.toLowerCase());
}

function normalizeCodec(codec?: string): string {
  return (codec ?? "").toLowerCase().replace("mpeg4", "mp4v");
}

function normalizeContainer(container?: string): string {
  return (container ?? "")
    .toLowerCase()
    .split(",")[0]
    .trim()
    .replace("matroska", "mkv")
    .replace("quicktime", "mov");
}

function getMimeTypeForMediaSource(mediaSource: JellyfinMediaSource): string | undefined {
  const container = normalizeContainer(mediaSource.Container);
  const videoCodec = normalizeCodec(getMediaStream(mediaSource, "Video")?.Codec);
  const audioCodec = normalizeCodec(getMediaStream(mediaSource, "Audio")?.Codec);

  if (container === "mp4" || container === "m4v" || container === "mov") {
    const codecs: string[] = [];

    if (videoCodec === "h264") {
      codecs.push("avc1.42E01E");
    } else if (videoCodec === "hevc" || videoCodec === "h265") {
      codecs.push("hvc1");
    } else if (videoCodec === "av1") {
      codecs.push("av01.0.05M.08");
    }

    if (audioCodec === "aac") {
      codecs.push("mp4a.40.2");
    } else if (audioCodec === "mp3") {
      codecs.push("mp4a.6B");
    } else if (audioCodec === "ac3") {
      codecs.push("ac-3");
    } else if (audioCodec === "eac3") {
      codecs.push("ec-3");
    }

    return codecs.length > 0 ? `video/mp4; codecs="${codecs.join(", ")}"` : "video/mp4";
  }

  if (container === "webm") {
    const codecs: string[] = [];

    if (["vp8", "vp9", "av1"].includes(videoCodec)) {
      codecs.push(videoCodec === "av1" ? "av01.0.05M.08" : videoCodec);
    }

    if (["opus", "vorbis"].includes(audioCodec)) {
      codecs.push(audioCodec);
    }

    return codecs.length > 0 ? `video/webm; codecs="${codecs.join(", ")}"` : "video/webm";
  }

  return undefined;
}

function canBrowserPlayMediaSource(mediaSource: JellyfinMediaSource): boolean {
  const container = normalizeContainer(mediaSource.Container);

  if (!["mp4", "m4v", "mov", "webm"].includes(container)) {
    return false;
  }

  const mimeType = getMimeTypeForMediaSource(mediaSource);

  if (!mimeType || typeof document === "undefined") {
    return container === "mp4" || container === "m4v" || container === "mov";
  }

  const video = document.createElement("video");
  const support = video.canPlayType(mimeType);

  return support === "probably" || support === "maybe";
}

function buildDirectStreamUrl(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  playSessionId: string | undefined,
): string {
  const session = requireAuthSession();
  const container = normalizeContainer(mediaSource.Container);
  const path = container ? `/Videos/${encodeURIComponent(itemId)}/stream.${container}` : `/Videos/${itemId}/stream`;

  return buildJellyfinUrl(session.serverUrl, path, {
    static: true,
    mediaSourceId: mediaSource.Id,
    playSessionId,
    deviceId: session.deviceId,
    api_key: session.accessToken,
  });
}

function buildMasterHlsUrl(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  playSessionId: string | undefined,
  settings: PlaybackSourceSettings = {},
): string {
  const session = requireAuthSession();

  return buildJellyfinUrl(session.serverUrl, `/Videos/${encodeURIComponent(itemId)}/master.m3u8`, {
    mediaSourceId: mediaSource.Id,
    playSessionId,
    deviceId: session.deviceId,
    audioStreamIndex: settings.audioStreamIndex,
    videoCodec: "h264",
    audioCodec: "aac",
    maxStreamingBitrate: settings.maxStreamingBitrate ?? MAX_STREAMING_BITRATE,
    maxWidth: settings.maxWidth,
    maxHeight: settings.maxHeight,
    transcodingMaxAudioChannels: 6,
    segmentContainer: "ts",
    minSegments: 1,
    segmentLength: 6,
    enableAutoStreamCopy: false,
    allowVideoStreamCopy: false,
    allowAudioStreamCopy: false,
    enableAdaptiveBitrateStreaming: true,
    api_key: session.accessToken,
  });
}

export function buildConfiguredHlsPlaybackSource(
  source: PlaybackSourceCandidate,
  settings: PlaybackSourceSettings,
  label = "Custom HLS",
  reason = "Built a Jellyfin HLS URL for the selected player setting.",
): PlaybackSourceCandidate {
  if (!source.mediaSource.Id) {
    throw new Error("This media source does not have a Jellyfin mediaSourceId.");
  }

  if (!source.mediaSource.SupportsTranscoding && source.mode !== "Transcoding") {
    throw new Error("This Jellyfin media source does not report transcoding support.");
  }

  const url = buildMasterHlsUrl(source.itemId, source.mediaSource, source.playSessionId, settings);
  const idParts = [
    "SettingsHls",
    source.mediaSource.Id,
    settings.audioStreamIndex !== undefined ? `a${settings.audioStreamIndex}` : "a-auto",
    settings.maxHeight !== undefined ? `h${settings.maxHeight}` : "h-auto",
    settings.maxStreamingBitrate !== undefined ? `b${settings.maxStreamingBitrate}` : "b-auto",
  ];

  return {
    ...source,
    id: idParts.join("-"),
    mode: "Transcoding",
    url,
    mimeType: "application/vnd.apple.mpegurl",
    isHls: true,
    usingHlsJs: undefined,
    label,
    reason,
    priority: Math.min(source.priority, 9),
  };
}

export function buildSubtitleStreamUrl(itemId: string, mediaSourceId: string, subtitleStreamIndex: number): string {
  const session = requireAuthSession();

  return buildJellyfinUrl(
    session.serverUrl,
    `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${subtitleStreamIndex}/Stream.vtt`,
    {
      api_key: session.accessToken,
    },
  );
}

export function getManualQualityOptions(mediaSource: JellyfinMediaSource): PlaybackQualityOption[] {
  if (!mediaSource.SupportsTranscoding) {
    return [];
  }

  const videoStream = mediaSource.MediaStreams?.find((stream) => stream.Type?.toLowerCase() === "video");
  const sourceHeight = videoStream?.Height;
  const sourceWidth = videoStream?.Width;

  if (!sourceHeight || sourceHeight < 480) {
    return [];
  }

  const qualityPresets: Array<Omit<PlaybackQualityOption, "id">> = [
    {
      label: "4K",
      subtitle: "HLS · up to 80 Mbps",
      maxHeight: 2160,
      maxWidth: 3840,
      maxStreamingBitrate: 80_000_000,
    },
    {
      label: "1080p",
      subtitle: "HLS · up to 20 Mbps",
      maxHeight: 1080,
      maxWidth: 1920,
      maxStreamingBitrate: 20_000_000,
    },
    {
      label: "720p",
      subtitle: "HLS · up to 8 Mbps",
      maxHeight: 720,
      maxWidth: 1280,
      maxStreamingBitrate: 8_000_000,
    },
    {
      label: "480p",
      subtitle: "HLS · up to 4 Mbps",
      maxHeight: 480,
      maxWidth: 854,
      maxStreamingBitrate: 4_000_000,
    },
  ];

  return qualityPresets
    .filter((option) => option.maxHeight !== undefined && option.maxHeight <= sourceHeight)
    .map((option) => {
      const maxHeight = option.maxHeight;
      const maxWidth =
        option.maxWidth && sourceWidth && sourceHeight
          ? Math.min(option.maxWidth, Math.round((sourceWidth / sourceHeight) * (maxHeight ?? sourceHeight)))
          : option.maxWidth;

      return {
        ...option,
        id: `hls-${maxHeight ?? "auto"}-${option.maxStreamingBitrate}`,
        maxWidth,
      };
    });
}

function resolveTranscodingUrl(mediaSource: JellyfinMediaSource): string | null {
  const session = requireAuthSession();

  if (!mediaSource.TranscodingUrl) {
    return null;
  }

  return makePlaybackUrlAbsolute(mediaSource.TranscodingUrl, session.serverUrl, session.accessToken);
}

function isHlsUrl(playbackUrl: string, mediaSource?: JellyfinMediaSource): boolean {
  return (
    playbackUrl.toLowerCase().includes(".m3u8") ||
    mediaSource?.TranscodingSubProtocol?.toLowerCase() === "hls" ||
    mediaSource?.TranscodingContainer?.toLowerCase() === "ts"
  );
}

function createPlaybackCandidate(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  mode: PlaybackMode,
  url: string,
  playSessionId: string | undefined,
  priority: number,
  reason: string,
  mimeType: string | undefined,
  playbackInfo: JellyfinPlaybackInfoResponse,
): PlaybackSourceCandidate {
  return {
    id: `${mode}-${mediaSource.Id ?? "source"}-${priority}`,
    itemId,
    mediaSourceId: mediaSource.Id,
    playSessionId,
    mode,
    url,
    mimeType,
    isHls: isHlsUrl(url, mediaSource),
    label: mode,
    mediaSource,
    playbackInfo,
    reason,
    transcodeReasons: mediaSource.TranscodingReasons ?? [],
    directPlayError: mediaSource.DirectPlayError,
    priority,
  };
}

export function buildPlaybackCandidates(
  itemId: string,
  playbackInfo: JellyfinPlaybackInfoResponse,
): PlaybackSourceCandidate[] {
  const sources = playbackInfo.MediaSources ?? [];
  const candidates: PlaybackSourceCandidate[] = [];

  sources.forEach((mediaSource, sourceIndex) => {
    const canDirectPlay = Boolean(mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream);
    const browserCanPlay = canBrowserPlayMediaSource(mediaSource);
    const mimeType = getMimeTypeForMediaSource(mediaSource);
    const playSessionId = playbackInfo.PlaySessionId;
    const transcodingUrl = resolveTranscodingUrl(mediaSource);

    if (transcodingUrl) {
      candidates.push(
        createPlaybackCandidate(
          itemId,
          mediaSource,
          "Transcoding",
          transcodingUrl,
          playSessionId,
          browserCanPlay ? 35 + sourceIndex : 5 + sourceIndex,
          "Jellyfin returned a transcoding URL from PlaybackInfo.",
          isHlsUrl(transcodingUrl, mediaSource) ? "application/vnd.apple.mpegurl" : undefined,
          playbackInfo,
        ),
      );
    } else if (mediaSource.SupportsTranscoding && mediaSource.Id) {
      candidates.push(
        createPlaybackCandidate(
          itemId,
          mediaSource,
          "Transcoding",
          buildMasterHlsUrl(itemId, mediaSource, playSessionId),
          playSessionId,
          browserCanPlay ? 40 + sourceIndex : 8 + sourceIndex,
          "Built a Jellyfin HLS fallback URL from PlaybackInfo media source data.",
          "application/vnd.apple.mpegurl",
          playbackInfo,
        ),
      );
    }

    if (canDirectPlay) {
      const mode: PlaybackMode = mediaSource.SupportsDirectPlay ? "DirectPlay" : "DirectStream";
      candidates.push(
        createPlaybackCandidate(
          itemId,
          mediaSource,
          mode,
          buildDirectStreamUrl(itemId, mediaSource, playSessionId),
          playSessionId,
          browserCanPlay ? 10 + sourceIndex : 85 + sourceIndex,
          browserCanPlay
            ? "Container and codecs look browser-compatible."
            : "Direct URL kept as a last resort because this container or codec is risky in browsers.",
          mimeType,
          playbackInfo,
        ),
      );
    }
  });

  return candidates.sort((left, right) => left.priority - right.priority);
}

function getTokenForUrl(): string | undefined {
  return getAuthSession()?.accessToken;
}

export function getPrimaryImageUrl(itemId: string, tag?: string, maxWidth = 500): string {
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    return "";
  }

  return buildJellyfinUrl(serverUrl, `/Items/${encodeURIComponent(itemId)}/Images/Primary`, {
    maxWidth,
    quality: 90,
    tag,
    api_key: getTokenForUrl(),
  });
}

export function getLogoImageUrl(itemId: string, tag?: string, maxWidth = 900): string {
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    return "";
  }

  return buildJellyfinUrl(serverUrl, `/Items/${encodeURIComponent(itemId)}/Images/Logo`, {
    maxWidth,
    quality: 95,
    tag,
    api_key: getTokenForUrl(),
  });
}

export function getBackdropImageUrl(itemId: string, tag?: string, maxWidth = 1600): string {
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    return "";
  }

  return buildJellyfinUrl(serverUrl, `/Items/${encodeURIComponent(itemId)}/Images/Backdrop`, {
    maxWidth,
    quality: 88,
    imageIndex: 0,
    tag,
    api_key: getTokenForUrl(),
  });
}

export function getStreamUrl(itemId: string): string {
  const session = requireAuthSession();

  // Legacy direct URL helper kept for compatibility. The player now uses
  // PlaybackInfo candidates so it can fall back to Jellyfin HLS/transcoding.
  return buildJellyfinUrl(session.serverUrl, `/Videos/${encodeURIComponent(itemId)}/stream`, {
    static: true,
    deviceId: session.deviceId,
    api_key: session.accessToken,
  });
}

export function ticksFromSeconds(seconds: number): number {
  return Math.max(0, Math.floor(seconds * 10_000_000));
}

export async function reportPlaybackStart(itemId: string, positionTicks = 0): Promise<void> {
  // Basic progress reporting only. TODO: pair this with PlaybackInfo play sessions later.
  await requestJson<void>("/Sessions/Playing", {
    method: "POST",
    body: {
      ItemId: itemId,
      PositionTicks: positionTicks,
      CanSeek: true,
      PlayMethod: "DirectStream",
    },
  });
}

export async function reportPlaybackProgress(
  itemId: string,
  positionTicks: number,
  isPaused: boolean,
): Promise<void> {
  // Basic progress reporting only. TODO: include media source and play session ids later.
  await requestJson<void>("/Sessions/Playing/Progress", {
    method: "POST",
    body: {
      ItemId: itemId,
      PositionTicks: positionTicks,
      IsPaused: isPaused,
      CanSeek: true,
      PlayMethod: "DirectStream",
    },
  });
}

export async function reportPlaybackStopped(itemId: string, positionTicks: number): Promise<void> {
  await requestJson<void>("/Sessions/Playing/Stopped", {
    method: "POST",
    body: {
      ItemId: itemId,
      PositionTicks: positionTicks,
    },
  });
}

export async function stopActiveTranscodeSession(playSessionId?: string): Promise<void> {
  const session = requireAuthSession();

  if (!playSessionId) {
    return;
  }

  await requestJson<void>("/Videos/ActiveEncodings", {
    method: "DELETE",
    params: {
      deviceId: session.deviceId,
      playSessionId,
    },
  });
}
