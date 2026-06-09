import {
  createJellyfinAuthorizationHeader,
  getAuthHeaders,
  getAuthSession,
  getServerUrl,
  normalizeServerUrl,
} from "./authStorage";
import { sortCollectionItemsForWatching } from "./collectionUtils";
import type {
  JellyfinAuthResponse,
  JellyfinItem,
  JellyfinItemsResponse,
  JellyfinLibrary,
  JellyfinMediaSegment,
  JellyfinMediaSource,
  JellyfinMediaStream,
  JellyfinMetadataRefreshOptions,
  JellyfinPlaybackInfoResponse,
  JellyfinPublicSystemInfo,
  JellyfinSessionInfo,
  JellyfinTranscodingInfo,
  NormalizedMediaSegment,
  PlaybackQualityOption,
  PlaybackMode,
  PlaybackSourceCandidate,
  PlaybackSourceSettings,
  SegmentKind,
} from "./types";

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

type QueryParams = Record<string, QueryValue>;
type BuiltHlsKind = "stream-copy" | "forced-transcode" | "audio-transcode";

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  params?: QueryParams;
  auth?: boolean;
  deviceAuth?: boolean;
  serverUrlOverride?: string;
  keepalive?: boolean;
}

export const JELLYFIN_SERVER_UNAVAILABLE_EVENT =
  "seyirlik:jellyfin-server-unavailable";

class JellyfinRequestError extends Error {
  status: number;
  statusText: string;

  constructor(status: number, statusText: string, message: string) {
    super(message);
    this.name = "JellyfinRequestError";
    this.status = status;
    this.statusText = statusText;
  }
}

const DEFAULT_ITEM_FIELDS = [
  "PrimaryImageAspectRatio",
  "SortName",
  "OriginalTitle",
  "Overview",
  "ProviderIds",
  "Chapters",
  "Genres",
  "RunTimeTicks",
  "ProductionYear",
  "PremiereDate",
  "DateCreated",
  "IndexNumber",
  "ParentIndexNumber",
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

export function buildJellyfinUrl(
  serverUrl: string,
  path: string,
  params: QueryParams = {},
): string {
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

function makePlaybackUrlAbsolute(
  urlOrPath: string,
  serverUrl: string,
  token: string,
): string {
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
    return playbackUrl.replace(
      /(api_key|access_token)=([^&]+)/gi,
      "$1=REDACTED",
    );
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
      const json = JSON.parse(text) as {
        message?: string;
        Message?: string;
        error?: string;
      };
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
    keepalive = false,
  }: RequestOptions = {},
): Promise<TResponse> {
  const serverUrl = serverUrlOverride
    ? normalizeServerUrl(serverUrlOverride)
    : getServerUrl();

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

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive,
    });
  } catch (error) {
    if (!serverUrlOverride && typeof window !== "undefined") {
      window.dispatchEvent(new Event(JELLYFIN_SERVER_UNAVAILABLE_EVENT));
    }

    throw error;
  }

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new JellyfinRequestError(
      response.status,
      response.statusText,
      message,
    );
  }

  if (response.status === 204) {
    return undefined as TResponse;
  }

  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as TResponse;
}

export async function testServerConnection(
  serverUrl: string,
): Promise<JellyfinPublicSystemInfo> {
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

  const response = await requestJson<JellyfinItemsResponse<JellyfinLibrary>>(
    "/UserViews",
    {
      params: {
        userId: session.userId,
        includeExternalContent: false,
        includeHidden: false,
      },
    },
  );

  return response.Items ?? [];
}

export async function getItemsForLibrary(
  libraryId: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/Items",
    {
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
    },
  );

  return response.Items ?? [];
}

export async function getNextUpEpisodes(): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/Shows/NextUp",
    {
      params: {
        userId: session.userId,
        limit: 20,
        fields: DEFAULT_ITEM_FIELDS,
        enableImages: true,
        imageTypeLimit: 1,
        enableImageTypes: "Primary,Backdrop,Logo",
        enableUserData: true,
      },
    },
  );

  return response.Items ?? [];
}

export async function getTopLevelItemsForLibrary(
  libraryId: string,
  collectionType?: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const includeItemTypes =
    collectionType === "tvshows"
      ? "Series"
      : collectionType === "movies"
        ? "Movie"
        : undefined;

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/Items",
    {
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
    },
  );

  return response.Items ?? [];
}

export async function getSeriesSeasons(
  seriesId: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/Shows/Seasons",
    {
      params: {
        userId: session.userId,
        seriesId,
        fields: DEFAULT_ITEM_FIELDS,
        enableImages: true,
        imageTypeLimit: 1,
        enableImageTypes: "Primary,Backdrop,Logo",
      },
    },
  );

  return response.Items ?? [];
}

export async function getSeasonEpisodes(
  seriesId: string,
  seasonId: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/Shows/Episodes",
    {
      params: {
        userId: session.userId,
        seriesId,
        seasonId,
        fields: DEFAULT_ITEM_FIELDS,
        enableImages: true,
        imageTypeLimit: 1,
        enableImageTypes: "Primary,Backdrop,Logo",
      },
    },
  );

  return response.Items ?? [];
}

function getEpisodeSeasonId(item: JellyfinItem): string | null {
  return item.SeasonId ?? item.ParentId ?? null;
}

function getEpisodeCandidateTexts(item: JellyfinItem): string[] {
  return [item.Name, item.SortName, item.SeriesName, item.SeasonName].filter(
    (value): value is string => Boolean(value?.trim()),
  );
}

function parseEpisodeNumberFromText(text: string): number | null {
  const patterns = [
    /(?:^|[^a-z0-9])s\d{1,2}\s*e(\d{1,3})(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])(\d{1,2})\s*x\s*(\d{1,3})(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])e(\d{1,3})(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])episode\s+(\d{1,3})(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])bölüm\s+(\d{1,3})(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])bolum\s+(\d{1,3})(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])böl\s+(\d{1,3})(?:[^a-z0-9]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);

    if (!match) {
      continue;
    }

    const episodeGroup = match.length > 2 ? match[2] : match[1];
    const parsed = episodeGroup ? Number(episodeGroup) : NaN;

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function parseSeasonNumberFromText(text: string): number | null {
  const patterns = [
    /(?:^|[^a-z0-9])s(\d{1,2})\s*e\d{1,3}(?:[^a-z0-9]|$)/i,
    /(?:^|[^a-z0-9])(\d{1,2})\s*x\s*\d{1,3}(?:[^a-z0-9]|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const parsed = match?.[1] ? Number(match[1]) : NaN;

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function getEpisodeIndexNumber(item: JellyfinItem): number | null {
  const indexNumber = item.IndexNumber;

  if (typeof indexNumber === "number" && Number.isFinite(indexNumber)) {
    return indexNumber;
  }

  for (const text of getEpisodeCandidateTexts(item)) {
    const parsedEpisodeNumber = parseEpisodeNumberFromText(text);

    if (parsedEpisodeNumber !== null) {
      return parsedEpisodeNumber;
    }
  }

  return null;
}

function getEpisodeSeasonNumber(item: JellyfinItem): number | null {
  const parentIndexNumber = item.ParentIndexNumber;

  if (
    typeof parentIndexNumber === "number" &&
    Number.isFinite(parentIndexNumber)
  ) {
    return parentIndexNumber;
  }

  for (const text of getEpisodeCandidateTexts(item)) {
    const parsedSeasonNumber = parseSeasonNumberFromText(text);

    if (parsedSeasonNumber !== null) {
      return parsedSeasonNumber;
    }
  }

  return null;
}

function getNextEpisodeDebugPayload(
  item: JellyfinItem,
): Record<string, unknown> {
  return {
    id: item.Id,
    name: item.Name,
    type: item.Type,
    seasonId: getEpisodeSeasonId(item),
    seriesId: item.SeriesId ?? null,
    indexNumber: item.IndexNumber ?? null,
    parsedEpisodeNumber: getEpisodeIndexNumber(item),
    parentIndexNumber: item.ParentIndexNumber ?? null,
    parsedSeasonNumber: getEpisodeSeasonNumber(item),
    candidateTexts: getEpisodeCandidateTexts(item),
  };
}

function compareEpisodeOrder(left: JellyfinItem, right: JellyfinItem): number {
  const leftIndex = getEpisodeIndexNumber(left);
  const rightIndex = getEpisodeIndexNumber(right);

  if (leftIndex !== null && rightIndex !== null && leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }

  if (leftIndex !== null && rightIndex === null) {
    return -1;
  }

  if (leftIndex === null && rightIndex !== null) {
    return 1;
  }

  const leftParentIndex = getEpisodeSeasonNumber(left);
  const rightParentIndex = getEpisodeSeasonNumber(right);

  if (
    leftParentIndex !== null &&
    rightParentIndex !== null &&
    leftParentIndex !== rightParentIndex
  ) {
    return leftParentIndex - rightParentIndex;
  }

  if (leftParentIndex !== null && rightParentIndex === null) {
    return -1;
  }

  if (leftParentIndex === null && rightParentIndex !== null) {
    return 1;
  }

  return (left.SortName ?? left.Name).localeCompare(
    right.SortName ?? right.Name,
    undefined,
    { numeric: true, sensitivity: "base" },
  );
}

async function getEpisodesBySeasonParentId(
  seasonId: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/Items",
    {
      params: {
        userId: session.userId,
        parentId: seasonId,
        recursive: false,
        includeItemTypes: "Episode",
        sortBy: "IndexNumber,SortName",
        sortOrder: "Ascending",
        fields: DEFAULT_ITEM_FIELDS,
        enableImages: true,
        imageTypeLimit: 1,
        enableImageTypes: "Primary,Backdrop,Logo",
      },
    },
  );

  return response.Items ?? [];
}

export async function getNextEpisodeInSeason(
  currentEpisode: JellyfinItem,
): Promise<JellyfinItem | null> {
  if (currentEpisode.Type !== "Episode") {
    console.debug(
      "[Seyirlik Next Episode] Skipping next episode lookup for non-episode item",
      getNextEpisodeDebugPayload(currentEpisode),
    );
    return null;
  }

  const seasonId = getEpisodeSeasonId(currentEpisode);
  const currentIndexNumber = getEpisodeIndexNumber(currentEpisode);

  if (!seasonId) {
    console.debug(
      "[Seyirlik Next Episode] Could not determine season id for current episode",
      getNextEpisodeDebugPayload(currentEpisode),
    );
    return null;
  }

  if (currentIndexNumber === null) {
    console.debug(
      "[Seyirlik Next Episode] Could not determine episode number for current episode; continuing with ordered fallback",
      getNextEpisodeDebugPayload(currentEpisode),
    );
  }

  let episodes: JellyfinItem[] = [];

  if (currentEpisode.SeriesId) {
    try {
      episodes = await getSeasonEpisodes(currentEpisode.SeriesId, seasonId);
    } catch (error) {
      console.warn(
        "[Seyirlik Next Episode] Failed to get episodes by SeriesId",
        error,
      );
    }
  }

  if (episodes.length === 0) {
    try {
      episodes = await getEpisodesBySeasonParentId(seasonId);
    } catch (error) {
      console.warn(
        "[Seyirlik Next Episode] Failed to get episodes by SeasonParentId",
        error,
      );
    }
  }

  const orderedEpisodes = episodes
    .filter((episode) => {
      const episodeSeasonId = getEpisodeSeasonId(episode);

      return (
        episode.Type === "Episode" &&
        episode.Id !== currentEpisode.Id &&
        (!episodeSeasonId ||
          episodeSeasonId === seasonId ||
          episodeSeasonId === currentEpisode.SeriesId)
      );
    })
    .sort(compareEpisodeOrder);

  let nextEpisode =
    orderedEpisodes.find((episode) => {
      const episodeIndexNumber = getEpisodeIndexNumber(episode);

      return (
        currentIndexNumber !== null &&
        episodeIndexNumber !== null &&
        episodeIndexNumber > currentIndexNumber
      );
    }) ?? null;

  if (!nextEpisode && currentIndexNumber === null) {
    const originalIndex = episodes.findIndex(
      (episode) => episode.Id === currentEpisode.Id,
    );

    if (originalIndex >= 0) {
      for (let index = originalIndex + 1; index < episodes.length; index += 1) {
        const candidate = episodes[index];

        if (
          candidate?.Type === "Episode" &&
          candidate.Id !== currentEpisode.Id
        ) {
          nextEpisode = candidate;
          break;
        }
      }
    }
  }

  console.debug(
    nextEpisode
      ? "[Seyirlik Next Episode] Found next episode in season"
      : "[Seyirlik Next Episode] No next episode found in season",
    {
      currentEpisode: getNextEpisodeDebugPayload(currentEpisode),
      fetchedEpisodeCount: episodes.length,
      orderedCandidates: orderedEpisodes.map((episode) =>
        getNextEpisodeDebugPayload(episode),
      ),
      selectedNextEpisode: nextEpisode
        ? getNextEpisodeDebugPayload(nextEpisode)
        : null,
    },
  );

  return nextEpisode;
}

export async function getAllSeriesEpisodes(
  seriesId: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    `/Shows/${encodeURIComponent(seriesId)}/Episodes`,
    {
      params: {
        userId: session.userId,
        fields: DEFAULT_ITEM_FIELDS,
        enableImages: true,
        imageTypeLimit: 1,
        enableImageTypes: "Primary,Backdrop,Logo",
        enableUserData: true,
        sortBy: "ParentIndexNumber,IndexNumber,SortName",
        sortOrder: "Ascending",
      },
    },
  );

  return response.Items ?? [];
}

async function getAllItemsByType(
  includeItemTypes: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();
  const allItems: JellyfinItem[] = [];
  const limit = 200;
  let startIndex = 0;
  let totalRecordCount = Number.POSITIVE_INFINITY;

  while (startIndex < totalRecordCount) {
    const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
      "/Items",
      {
        params: {
          userId: session.userId,
          recursive: true,
          includeItemTypes,
          sortBy: "SortName",
          sortOrder: "Ascending",
          fields: DEFAULT_ITEM_FIELDS,
          enableImages: true,
          imageTypeLimit: 1,
          enableImageTypes: "Primary,Backdrop,Logo",
          enableUserData: true,
          startIndex,
          limit,
        },
      },
    );

    const items = response.Items ?? [];
    allItems.push(...items);

    totalRecordCount = response.TotalRecordCount ?? allItems.length;

    if (items.length === 0) {
      break;
    }

    startIndex += items.length;
  }

  return allItems;
}

export async function getAllMovieItems(): Promise<JellyfinItem[]> {
  return getAllItemsByType("Movie");
}

export async function getAllBoxSetItems(): Promise<JellyfinItem[]> {
  return getAllItemsByType("BoxSet");
}

export async function getBoxSetItems(
  boxSetId: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/Items",
    {
      params: {
        userId: session.userId,
        parentId: boxSetId,
        recursive: false,
        includeItemTypes: "Movie",
        sortBy: "PremiereDate,ProductionYear,SortName",
        sortOrder: "Ascending",
        fields: DEFAULT_ITEM_FIELDS,
        enableImages: true,
        imageTypeLimit: 1,
        enableImageTypes: "Primary,Backdrop,Logo",
        enableUserData: true,
      },
    },
  );

  return sortCollectionItemsForWatching(response.Items ?? []);
}

export async function markItemUnplayed(itemId: string): Promise<void> {
  const session = requireAuthSession();

  try {
    await requestJson<unknown>(
      `/UserPlayedItems/${encodeURIComponent(itemId)}`,
      {
        method: "DELETE",
        params: {
          userId: session.userId,
        },
      },
    );
  } catch (error) {
    if (!(error instanceof JellyfinRequestError) || error.status !== 404) {
      throw error;
    }

    await requestJson<unknown>(
      `/Users/${encodeURIComponent(session.userId)}/PlayedItems/${encodeURIComponent(itemId)}`,
      {
        method: "DELETE",
      },
    );
  }
}

export async function markItemPlayed(itemId: string): Promise<void> {
  const session = requireAuthSession();

  try {
    await requestJson<unknown>(
      `/UserPlayedItems/${encodeURIComponent(itemId)}`,
      {
        method: "POST",
        params: {
          userId: session.userId,
        },
      },
    );
  } catch (error) {
    if (!(error instanceof JellyfinRequestError) || error.status !== 404) {
      throw error;
    }

    await requestJson<unknown>(
      `/Users/${encodeURIComponent(session.userId)}/PlayedItems/${encodeURIComponent(itemId)}`,
      {
        method: "POST",
      },
    );
  }
}

export async function updateItemUserData(
  itemId: string,
  userData: Partial<NonNullable<JellyfinItem["UserData"]>>,
): Promise<NonNullable<JellyfinItem["UserData"]>> {
  const session = requireAuthSession();

  return requestJson<NonNullable<JellyfinItem["UserData"]>>(
    `/UserItems/${encodeURIComponent(itemId)}/UserData`,
    {
      method: "POST",
      params: {
        userId: session.userId,
      },
      body: userData,
    },
  );
}

export async function resetItemWatchedStatus(itemId: string): Promise<void> {
  const item = await getItem(itemId).catch(() => null);
  const currentUserData = item?.UserData ?? {};

  try {
    await updateItemUserData(itemId, {
      ...currentUserData,
      PlaybackPositionTicks: 0,
      PlayedPercentage: 0,
      Played: false,
    });
    return;
  } catch (error) {
    if (!(error instanceof JellyfinRequestError) || error.status !== 404) {
      throw error;
    }
  }

  await markItemUnplayed(itemId);
  await requestJson<void>("/Sessions/Playing/Stopped", {
    method: "POST",
    body: {
      ItemId: itemId,
      PositionTicks: 0,
    },
  }).catch(() => undefined);
}

export async function markItemWatchedStatus(itemId: string): Promise<void> {
  const item = await getItem(itemId).catch(() => null);
  const currentUserData = item?.UserData ?? {};

  try {
    await updateItemUserData(itemId, {
      ...currentUserData,
      PlaybackPositionTicks:
        item?.RunTimeTicks ?? currentUserData.PlaybackPositionTicks ?? 0,
      PlayedPercentage: 100,
      Played: true,
      LastPlayedDate: new Date().toISOString(),
    });
    return;
  } catch (error) {
    if (!(error instanceof JellyfinRequestError) || error.status !== 404) {
      throw error;
    }
  }

  await markItemPlayed(itemId);
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
    return await requestJson<JellyfinItem>(
      `/Users/${encodeURIComponent(session.userId)}/Items/${encodeURIComponent(itemId)}`,
      {
        params,
      },
    );
  } catch (userScopedError) {
    try {
      return await requestJson<JellyfinItem>(
        `/Items/${encodeURIComponent(itemId)}`,
        {
          params,
        },
      );
    } catch {
      throw userScopedError;
    }
  }
}

export async function getContinueWatchingItems(): Promise<JellyfinItem[]> {
  const session = requireAuthSession();

  const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
    "/UserItems/Resume",
    {
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
    },
  );

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

export async function getAllMovieAndSeriesItems(): Promise<JellyfinItem[]> {
  const session = requireAuthSession();
  const allItems: JellyfinItem[] = [];
  const limit = 200;
  let startIndex = 0;
  let totalRecordCount = Number.POSITIVE_INFINITY;

  while (startIndex < totalRecordCount) {
    const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
      "/Items",
      {
        params: {
          userId: session.userId,
          recursive: true,
          includeItemTypes: "Movie,Series",
          sortBy: "SortName",
          sortOrder: "Ascending",
          fields: DEFAULT_ITEM_FIELDS,
          enableImages: true,
          imageTypeLimit: 1,
          enableImageTypes: "Primary,Backdrop,Logo",
          enableUserData: true,
          startIndex,
          limit,
        },
      },
    );

    const items = response.Items ?? [];
    allItems.push(...items);

    totalRecordCount = response.TotalRecordCount ?? allItems.length;

    if (items.length === 0) {
      break;
    }

    startIndex += items.length;
  }

  return allItems;
}

export async function getAllVideoItems(): Promise<JellyfinItem[]> {
  const session = requireAuthSession();
  const allItems: JellyfinItem[] = [];
  const limit = 200;
  let startIndex = 0;
  let totalRecordCount = Number.POSITIVE_INFINITY;

  while (startIndex < totalRecordCount) {
    const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
      "/Items",
      {
        params: {
          userId: session.userId,
          recursive: true,
          includeItemTypes: "Movie,Episode",
          mediaTypes: "Video",
          sortBy: "SortName",
          sortOrder: "Ascending",
          fields: DEFAULT_ITEM_FIELDS,
          enableImages: false,
          startIndex,
          limit,
        },
      },
    );

    const items = response.Items ?? [];
    allItems.push(...items);

    totalRecordCount = response.TotalRecordCount ?? allItems.length;

    if (items.length === 0) {
      break;
    }

    startIndex += items.length;
  }

  return allItems;
}

export async function getVideoItemsForLibrary(
  libraryId: string,
): Promise<JellyfinItem[]> {
  const session = requireAuthSession();
  const allItems: JellyfinItem[] = [];
  const limit = 200;
  let startIndex = 0;
  let totalRecordCount = Number.POSITIVE_INFINITY;

  while (startIndex < totalRecordCount) {
    const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
      "/Items",
      {
        params: {
          userId: session.userId,
          parentId: libraryId,
          recursive: true,
          includeItemTypes: "Movie,Series,Episode,Video",
          sortBy: "SortName",
          sortOrder: "Ascending",
          fields: DEFAULT_ITEM_FIELDS,
          enableImages: true,
          imageTypeLimit: 1,
          enableImageTypes: "Primary,Backdrop,Logo",
          startIndex,
          limit,
        },
      },
    );

    const items = response.Items ?? [];
    allItems.push(...items);

    totalRecordCount = response.TotalRecordCount ?? allItems.length;

    if (items.length === 0) {
      break;
    }

    startIndex += items.length;
  }

  return allItems;
}

export async function getAllContentItems(): Promise<JellyfinItem[]> {
  const session = requireAuthSession();
  const allItems: JellyfinItem[] = [];
  const limit = 200;
  let startIndex = 0;
  let totalRecordCount = Number.POSITIVE_INFINITY;

  while (startIndex < totalRecordCount) {
    const response = await requestJson<JellyfinItemsResponse<JellyfinItem>>(
      "/Items",
      {
        params: {
          userId: session.userId,
          recursive: true,
          sortBy: "SortName",
          sortOrder: "Ascending",
          fields: DEFAULT_ITEM_FIELDS,
          enableImages: true,
          imageTypeLimit: 1,
          enableImageTypes: "Primary,Backdrop,Logo",
          startIndex,
          limit,
        },
      },
    );

    const items = response.Items ?? [];
    allItems.push(...items);

    totalRecordCount = response.TotalRecordCount ?? allItems.length;

    if (items.length === 0) {
      break;
    }

    startIndex += items.length;
  }

  return allItems;
}

export async function scanAllLibraries(): Promise<void> {
  await requestJson<void>("/Library/Refresh", {
    method: "POST",
  });
}

export async function refreshLibraryMetadata(libraryId: string): Promise<void> {
  await requestJson<void>(`/Items/${encodeURIComponent(libraryId)}/Refresh`, {
    method: "POST",
    params: {
      recursive: true,
      metadataRefreshMode: "Default",
      imageRefreshMode: "Default",
      replaceAllMetadata: false,
      replaceAllImages: false,
    },
  });
}

export async function refreshItemMetadata(
  itemId: string,
  options: JellyfinMetadataRefreshOptions = {},
): Promise<void> {
  await requestJson<void>(`/Items/${encodeURIComponent(itemId)}/Refresh`, {
    method: "POST",
    params: {
      recursive: true,
      metadataRefreshMode: options.metadataRefreshMode ?? "Default",
      imageRefreshMode: options.imageRefreshMode ?? "Default",
      replaceAllMetadata: options.replaceAllMetadata ?? false,
      replaceAllImages: options.replaceAllImages ?? false,
    },
  });
}

export async function updateItemMetadata(
  itemId: string,
  item: JellyfinItem,
): Promise<void> {
  await requestJson<void>(`/Items/${encodeURIComponent(itemId)}`, {
    method: "POST",
    body: item,
  });
}

function getBrowserDeviceProfile(): Record<string, unknown> {
  return {
    Name: "Seyirlik HTML5",
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
        Container: "mp4",
        Protocol: "hls",
        VideoCodec: "h264,hevc,av1",
        AudioCodec: "aac,mp3,ac3,eac3",
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

export async function getPlaybackInfo(
  itemId: string,
): Promise<JellyfinPlaybackInfoResponse> {
  const session = requireAuthSession();

  return requestJson<JellyfinPlaybackInfoResponse>(
    `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
    {
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
    },
  );
}

const TICKS_PER_SECOND = 10_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getFirstValue(
  record: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  return undefined;
}

function secondsFromTicks(value: unknown): number | null {
  const ticks = getFiniteNumber(value);
  return ticks === null ? null : ticks / TICKS_PER_SECOND;
}

function secondsFromSecondsOrTicks(value: unknown): number | null {
  const timestamp = getFiniteNumber(value);

  if (timestamp === null) {
    return null;
  }

  return Math.abs(timestamp) > TICKS_PER_SECOND
    ? timestamp / TICKS_PER_SECOND
    : timestamp;
}

function getMediaSegmentEntries(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response;
  }

  if (!isRecord(response)) {
    return [];
  }

  const candidateKeys = [
    "Items",
    "Segments",
    "MediaSegments",
    "items",
    "segments",
    "mediaSegments",
  ];

  for (const key of candidateKeys) {
    const value = response[key];

    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function normalizeMediaSegment(
  rawSegment: unknown,
  index: number,
): NormalizedMediaSegment | null {
  if (!isRecord(rawSegment)) {
    return null;
  }

  const type = getStringValue(
    rawSegment.Type ?? rawSegment.type,
  ) as SegmentKind | null;

  if (!type) {
    return null;
  }

  const startTicks = getFirstValue(rawSegment, [
    "StartTicks",
    "BeginTicks",
    "StartPositionTicks",
    "startTicks",
    "beginTicks",
  ]);
  const endTicks = getFirstValue(rawSegment, [
    "EndTicks",
    "EndPositionTicks",
    "endTicks",
  ]);
  const startSeconds =
    startTicks !== undefined
      ? secondsFromTicks(startTicks)
      : secondsFromSecondsOrTicks(rawSegment.Start ?? rawSegment.start);
  const endSeconds =
    endTicks !== undefined
      ? secondsFromTicks(endTicks)
      : secondsFromSecondsOrTicks(rawSegment.End ?? rawSegment.end);

  if (
    startSeconds === null ||
    endSeconds === null ||
    startSeconds < 0 ||
    endSeconds <= startSeconds
  ) {
    return null;
  }

  const explicitId = getStringValue(rawSegment.Id ?? rawSegment.id);
  const id =
    explicitId ??
    `${type}-${startSeconds.toFixed(3)}-${endSeconds.toFixed(3)}-${index}`;

  return {
    id,
    type,
    startSeconds,
    endSeconds,
  };
}

export async function getMediaSegments(
  itemId: string,
): Promise<NormalizedMediaSegment[]> {
  try {
    const response = await requestJson<
      JellyfinMediaSegment[] | Record<string, unknown>
    >(`/MediaSegments/${encodeURIComponent(itemId)}`);

    return getMediaSegmentEntries(response)
      .map((segment, index) => normalizeMediaSegment(segment, index))
      .filter((segment): segment is NormalizedMediaSegment => segment !== null)
      .sort((left, right) => left.startSeconds - right.startSeconds);
  } catch (error) {
    if (error instanceof JellyfinRequestError) {
      if (error.status === 401 || error.status === 403) {
        throw error;
      }

      const logPayload = {
        itemId,
        status: error.status,
        statusText: error.statusText,
        message: error.message,
      };

      if (
        error.status === 404 ||
        error.status === 405 ||
        error.status === 501
      ) {
        console.debug(
          "[Seyirlik Playback] Jellyfin media segments endpoint unavailable",
          logPayload,
        );
      } else {
        console.warn(
          "[Seyirlik Playback] Could not load Jellyfin media segments",
          logPayload,
        );
      }

      return [];
    }

    throw error;
  }
}

export async function getActiveTranscodingInfo(
  itemId: string,
  playSessionId?: string,
): Promise<JellyfinTranscodingInfo | null> {
  const sessions = await requestJson<JellyfinSessionInfo[]>("/Sessions", {
    params: {
      activeWithinSeconds: 30,
    },
  });

  const matchingSession = sessions.find((session) => {
    const sessionPlaySessionId =
      session.PlayState?.PlaySessionId ??
      session.TranscodingInfo?.PlaySessionId;
    const nowPlayingItemId = session.NowPlayingItem?.Id;

    if (playSessionId && sessionPlaySessionId === playSessionId) {
      return true;
    }

    return nowPlayingItemId === itemId;
  });

  return matchingSession?.TranscodingInfo ?? null;
}

export async function getActiveTranscodingReasons(
  itemId: string,
  playSessionId?: string,
): Promise<string[]> {
  const transcodingInfo = await getActiveTranscodingInfo(itemId, playSessionId);

  if (!transcodingInfo) {
    return [];
  }

  const reasons = [
    ...(transcodingInfo.TranscodeReasons ?? []),
    ...(transcodingInfo.TranscodingReasons ?? []),
    ...(transcodingInfo.ReasonForTranscoding
      ? [transcodingInfo.ReasonForTranscoding]
      : []),
  ];

  return Array.from(new Set(reasons.filter(Boolean)));
}

function getMediaStream(
  mediaSource: JellyfinMediaSource,
  type: "Video" | "Audio",
): JellyfinMediaStream | undefined {
  return mediaSource.MediaStreams?.find(
    (stream) => stream.Type?.toLowerCase() === type.toLowerCase(),
  );
}

function getDefaultAudioStreamIndex(
  mediaSource: JellyfinMediaSource,
): number | undefined {
  if (mediaSource.DefaultAudioStreamIndex !== undefined) {
    return mediaSource.DefaultAudioStreamIndex;
  }

  return (
    mediaSource.MediaStreams?.find(
      (stream) => stream.Type?.toLowerCase() === "audio" && stream.IsDefault,
    )?.Index ??
    mediaSource.MediaStreams?.find(
      (stream) => stream.Type?.toLowerCase() === "audio",
    )?.Index
  );
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

function getVideoCodecForMediaSource(mediaSource: JellyfinMediaSource): string {
  return normalizeCodec(getMediaStream(mediaSource, "Video")?.Codec);
}

function getAudioCodecForMediaSource(mediaSource: JellyfinMediaSource): string {
  return normalizeCodec(getMediaStream(mediaSource, "Audio")?.Codec);
}

function isHevcCodec(codec: string): boolean {
  return codec === "hevc" || codec === "h265";
}

function isAv1Codec(codec: string): boolean {
  return codec === "av1";
}

function shouldPreferFmp4Hls(mediaSource: JellyfinMediaSource): boolean {
  const videoCodec = getVideoCodecForMediaSource(mediaSource);

  // Mirrors Jellyfin's "Prefer fMP4-HLS Media Container" behavior: fMP4 HLS
  // allows HEVC/AV1 to direct stream through HLS on supported clients.
  return isHevcCodec(videoCodec) || isAv1Codec(videoCodec);
}

function isBrowserMp4FamilyContainer(container: string): boolean {
  return ["mp4", "m4v", "mov"].includes(container);
}

function isSdrVideoStream(stream?: JellyfinMediaStream): boolean {
  const videoRange = stream?.VideoRange?.toLowerCase() ?? "";
  const videoRangeType = stream?.VideoRangeType?.toLowerCase() ?? "";

  return (
    !videoRange.includes("hdr") &&
    !videoRangeType.includes("hdr") &&
    !videoRangeType.includes("dolby")
  );
}

function shouldOfferAudioTranscodeHls(
  mediaSource: JellyfinMediaSource,
): boolean {
  const container = normalizeContainer(mediaSource.Container);
  const videoStream = getMediaStream(mediaSource, "Video");
  const videoCodec = getVideoCodecForMediaSource(mediaSource);
  const audioCodec = getAudioCodecForMediaSource(mediaSource);

  return (
    Boolean(mediaSource.SupportsTranscoding && mediaSource.Id) &&
    isBrowserMp4FamilyContainer(container) &&
    videoCodec === "h264" &&
    isSdrVideoStream(videoStream) &&
    audioCodec !== "aac"
  );
}

function isSafariBrowser(): boolean {
  if (typeof navigator === "undefined") return false;

  const ua = navigator.userAgent;

  return (
    /Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox/i.test(ua)
  );
}

function isAppleBrowser(): boolean {
  if (typeof navigator === "undefined") return false;

  return (
    isSafariBrowser() || /iPhone|iPad|Macintosh/i.test(navigator.userAgent)
  );
}

function getH264Avc1Codec(stream?: JellyfinMediaStream): string {
  const profile = (stream?.Profile ?? "").toLowerCase();
  const level = stream?.Level;

  let profileHex = "42";

  if (profile.includes("high")) {
    profileHex = "64";
  } else if (profile.includes("main")) {
    profileHex = "4D";
  } else if (profile.includes("baseline") || profile.includes("constrained")) {
    profileHex = "42";
  }

  const compatibility = "00";
  const levelHex =
    typeof level === "number" && Number.isFinite(level)
      ? Math.max(0, Math.min(255, level))
          .toString(16)
          .padStart(2, "0")
          .toUpperCase()
      : "1E";

  return `avc1.${profileHex}${compatibility}${levelHex}`;
}

function getMimeTypeForMediaSource(
  mediaSource: JellyfinMediaSource,
): string | undefined {
  const container = normalizeContainer(mediaSource.Container);
  const videoStream = getMediaStream(mediaSource, "Video");
  const audioStream = getMediaStream(mediaSource, "Audio");
  const videoCodec = normalizeCodec(videoStream?.Codec);
  const audioCodec = normalizeCodec(audioStream?.Codec);

  if (container === "mp4" || container === "m4v" || container === "mov") {
    const codecs: string[] = [];

    if (videoCodec === "h264") {
      codecs.push(getH264Avc1Codec(videoStream));
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

    return codecs.length > 0
      ? `video/mp4; codecs="${codecs.join(", ")}"`
      : "video/mp4";
  }

  if (container === "webm") {
    const codecs: string[] = [];

    if (["vp8", "vp9", "av1"].includes(videoCodec)) {
      codecs.push(videoCodec === "av1" ? "av01.0.05M.08" : videoCodec);
    }

    if (["opus", "vorbis"].includes(audioCodec)) {
      codecs.push(audioCodec);
    }

    return codecs.length > 0
      ? `video/webm; codecs="${codecs.join(", ")}"`
      : "video/webm";
  }

  return undefined;
}

function getBrowserCanPlayResult(mediaSource: JellyfinMediaSource): {
  mimeType?: string;
  support: "" | "maybe" | "probably";
  browserCanPlay: boolean;
  reason: string;
} {
  const container = normalizeContainer(mediaSource.Container);
  const videoCodec = getVideoCodecForMediaSource(mediaSource);
  const audioStream = getMediaStream(mediaSource, "Audio");
  const audioCodec = normalizeCodec(audioStream?.Codec);
  const mimeType = getMimeTypeForMediaSource(mediaSource);

  if (!["mp4", "m4v", "mov", "webm"].includes(container)) {
    return {
      mimeType,
      support: "",
      browserCanPlay: false,
      reason: "Container is not browser-safe.",
    };
  }

  if (!mimeType || typeof document === "undefined") {
    return {
      mimeType,
      support: "",
      browserCanPlay: false,
      reason: "Could not build/test browser MIME type.",
    };
  }

  const video = document.createElement("video");
  const support = video.canPlayType(mimeType) as "" | "maybe" | "probably";
  const videoStream = getMediaStream(mediaSource, "Video");
  const isBrowserMp4Family = isBrowserMp4FamilyContainer(container);
  const isH264 = videoCodec === "h264";
  const isSdr = isSdrVideoStream(videoStream);
  const isSafariFriendlyAudio = ["aac", "mp3", "ac3", "eac3"].includes(
    audioCodec,
  );

  if (
    isSafariBrowser() &&
    isBrowserMp4Family &&
    isH264 &&
    isSdr &&
    isSafariFriendlyAudio
  ) {
    return {
      mimeType,
      support: support || "probably",
      browserCanPlay: true,
      reason: "Safari-safe H.264 SDR MP4/MOV source with compatible audio.",
    };
  }

  if (isHevcCodec(videoCodec)) {
    return {
      mimeType,
      support,
      browserCanPlay: support === "probably",
      reason:
        support === "probably"
          ? "Browser confidently reports HEVC support."
          : "HEVC support is uncertain or unavailable, so direct playback is risky.",
    };
  }

  return {
    mimeType,
    support,
    browserCanPlay: support === "probably" || support === "maybe",
    reason:
      support === "probably" || support === "maybe"
        ? "Browser reports playable media support."
        : "Browser reports this source is not playable.",
  };
}

function buildDirectStreamUrl(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  playSessionId: string | undefined,
): string {
  const session = requireAuthSession();
  const container = normalizeContainer(mediaSource.Container);
  const path = container
    ? `/Videos/${encodeURIComponent(itemId)}/stream.${container}`
    : `/Videos/${itemId}/stream`;

  return buildJellyfinUrl(session.serverUrl, path, {
    static: true,
    mediaSourceId: mediaSource.Id,
    playSessionId,
    deviceId: session.deviceId,
    api_key: session.accessToken,
  });
}

function getHlsDebugInfo(
  mediaSource: JellyfinMediaSource,
  url: string,
  segmentContainer: "mp4" | "ts",
  kind: BuiltHlsKind,
) {
  return {
    mediaSourceId: mediaSource.Id,
    sourceContainer: mediaSource.Container,
    videoCodec: getVideoCodecForMediaSource(mediaSource),
    audioCodec: getAudioCodecForMediaSource(mediaSource),
    segmentContainer,
    kind,
    url: redactPlaybackUrl(url),
  };
}

function logHlsCandidateUrl(
  mediaSource: JellyfinMediaSource,
  url: string,
  segmentContainer: "mp4" | "ts",
  kind: BuiltHlsKind,
): void {
  console.info(
    "[Seyirlik Playback] Built HLS candidate URL",
    getHlsDebugInfo(mediaSource, url, segmentContainer, kind),
  );
}

function buildStreamCopyHlsUrl(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  playSessionId: string | undefined,
  settings: PlaybackSourceSettings = {},
): string {
  const session = requireAuthSession();
  const segmentContainer = shouldPreferFmp4Hls(mediaSource) ? "mp4" : "ts";
  const url = buildJellyfinUrl(
    session.serverUrl,
    `/Videos/${encodeURIComponent(itemId)}/master.m3u8`,
    {
      MediaSourceId: mediaSource.Id,
      PlaySessionId: playSessionId,
      DeviceId: session.deviceId,

      AudioStreamIndex:
        settings.audioStreamIndex ?? getDefaultAudioStreamIndex(mediaSource),

      TranscodingMaxAudioChannels: 6,
      SegmentContainer: segmentContainer,
      MinSegments: 1,
      SegmentLength: 6,
      BreakOnNonKeyFrames: true,

      EnableAutoStreamCopy: true,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      EnableAdaptiveBitrateStreaming: true,

      api_key: session.accessToken,
    },
  );

  logHlsCandidateUrl(mediaSource, url, segmentContainer, "stream-copy");

  return url;
}

function buildAudioTranscodeHlsUrl(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  playSessionId: string | undefined,
  settings: PlaybackSourceSettings = {},
): string {
  const session = requireAuthSession();
  const audioBitrate = 640_000;
  const url = buildJellyfinUrl(
    session.serverUrl,
    `/Videos/${encodeURIComponent(itemId)}/master.m3u8`,
    {
      MediaSourceId: mediaSource.Id,
      PlaySessionId: playSessionId,
      DeviceId: session.deviceId,

      AudioStreamIndex:
        settings.audioStreamIndex ?? getDefaultAudioStreamIndex(mediaSource),

      AudioCodec: "aac",
      AudioBitrate: audioBitrate,
      TranscodingMaxAudioChannels: 6,

      SegmentContainer: "ts",
      MinSegments: 1,
      SegmentLength: 6,
      BreakOnNonKeyFrames: true,

      EnableAutoStreamCopy: false,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: false,
      EnableAdaptiveBitrateStreaming: true,

      api_key: session.accessToken,
    },
  );

  logHlsCandidateUrl(mediaSource, url, "ts", "audio-transcode");

  return url;
}

function buildForcedTranscodeHlsUrl(
  itemId: string,
  mediaSource: JellyfinMediaSource,
  playSessionId: string | undefined,
  settings: PlaybackSourceSettings = {},
): string {
  const session = requireAuthSession();
  const audioBitrate = 640_000;
  const totalBitrate = settings.maxStreamingBitrate ?? MAX_STREAMING_BITRATE;
  const videoBitrate = Math.max(1_000_000, totalBitrate - audioBitrate);

  const url = buildJellyfinUrl(
    session.serverUrl,
    `/Videos/${encodeURIComponent(itemId)}/main.m3u8`,
    {
      MediaSourceId: mediaSource.Id,
      PlaySessionId: playSessionId,
      DeviceId: session.deviceId,

      AudioStreamIndex:
        settings.audioStreamIndex ?? getDefaultAudioStreamIndex(mediaSource),

      VideoCodec: "h264",
      AudioCodec: "aac",

      MaxStreamingBitrate: totalBitrate,
      VideoBitrate: videoBitrate,
      AudioBitrate: audioBitrate,

      MaxWidth: settings.maxWidth,
      MaxHeight: settings.maxHeight,

      TranscodingMaxAudioChannels: 6,
      SegmentContainer: "ts",
      MinSegments: 1,
      SegmentLength: 6,
      BreakOnNonKeyFrames: true,

      EnableAutoStreamCopy: false,
      AllowVideoStreamCopy: false,
      AllowAudioStreamCopy: false,
      EnableAdaptiveBitrateStreaming: false,

      api_key: session.accessToken,
    },
  );

  logHlsCandidateUrl(mediaSource, url, "ts", "forced-transcode");

  return url;
}

export function getTrickplayImageUrl(
  itemId: string,
  mediaSourceId: string,
  resolution: number,
  imageIndex: number,
): string {
  const serverUrl = getServerUrl();
  const token = getTokenForUrl();

  if (!serverUrl || !token) {
    return "";
  }

  return buildJellyfinUrl(
    serverUrl,
    `/Videos/${encodeURIComponent(itemId)}/Trickplay/${resolution}/${imageIndex}.jpg`,
    {
      ApiKey: token,
      MediaSourceId: mediaSourceId,
    },
  );
}

export function buildConfiguredHlsPlaybackSource(
  source: PlaybackSourceCandidate,
  settings: PlaybackSourceSettings,
  label = "Custom HLS",
  reason = "Built a Jellyfin HLS URL for the selected player setting.",
): PlaybackSourceCandidate {
  const isManualQuality =
    settings.maxHeight !== undefined ||
    settings.maxWidth !== undefined ||
    settings.maxStreamingBitrate !== undefined;
  const shouldUseAudioTranscode =
    !isManualQuality &&
    (source.hlsKind === "audio-transcode" ||
      (source.hlsKind === "jellyfin-transcoding-url" &&
        shouldOfferAudioTranscodeHls(source.mediaSource)));
  const shouldForceTranscode =
    isManualQuality ||
    source.hlsKind === "forced-transcode" ||
    (source.mode === "Transcoding" &&
      source.hlsKind !== "jellyfin-transcoding-url" &&
      source.hlsKind !== "audio-transcode" &&
      !shouldUseAudioTranscode);

  if (!source.mediaSource.Id) {
    throw new Error(
      "This media source does not have a Jellyfin mediaSourceId.",
    );
  }

  if (
    !source.mediaSource.SupportsTranscoding &&
    source.mode !== "Transcoding"
  ) {
    throw new Error(
      "This Jellyfin media source does not report transcoding support.",
    );
  }

  const url = shouldUseAudioTranscode
    ? buildAudioTranscodeHlsUrl(
        source.itemId,
        source.mediaSource,
        source.playSessionId,
        settings,
      )
    : shouldForceTranscode
      ? buildForcedTranscodeHlsUrl(
          source.itemId,
          source.mediaSource,
          source.playSessionId,
          settings,
        )
      : buildStreamCopyHlsUrl(
          source.itemId,
          source.mediaSource,
          source.playSessionId,
          settings,
        );
  const idParts = [
    "SettingsHls",
    source.mediaSource.Id,
    settings.audioStreamIndex !== undefined
      ? `a${settings.audioStreamIndex}`
      : `a-default-${getDefaultAudioStreamIndex(source.mediaSource) ?? "auto"}`,
    settings.maxHeight !== undefined ? `h${settings.maxHeight}` : "h-auto",
    settings.maxStreamingBitrate !== undefined
      ? `b${settings.maxStreamingBitrate}`
      : "b-auto",
  ];

  return {
    ...source,
    id: idParts.join("-"),
    mode:
      shouldUseAudioTranscode || shouldForceTranscode
        ? "Transcoding"
        : source.mode === "DirectPlay"
          ? "DirectStream"
          : source.mode,
    url,
    mimeType: "application/vnd.apple.mpegurl",
    isHls: true,
    hlsKind: shouldUseAudioTranscode
      ? "audio-transcode"
      : shouldForceTranscode
        ? "forced-transcode"
        : "stream-copy",
    usingHlsJs: undefined,
    label,
    reason,
    priority: shouldForceTranscode
      ? Math.min(source.priority, 9)
      : shouldUseAudioTranscode
        ? Math.min(source.priority, 8)
        : source.priority,
  };
}

export function buildSubtitleStreamUrl(
  itemId: string,
  mediaSourceId: string,
  subtitleStreamIndex: number,
): string {
  const session = requireAuthSession();

  return buildJellyfinUrl(
    session.serverUrl,
    `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${subtitleStreamIndex}/Stream.vtt`,
    {
      api_key: session.accessToken,
    },
  );
}

export function getManualQualityOptions(
  mediaSource: JellyfinMediaSource,
): PlaybackQualityOption[] {
  if (!mediaSource.SupportsTranscoding) {
    return [];
  }

  const videoStream = mediaSource.MediaStreams?.find(
    (stream) => stream.Type?.toLowerCase() === "video",
  );
  const sourceHeight = videoStream?.Height;
  const sourceWidth = videoStream?.Width;

  if (!sourceHeight || sourceHeight < 480) {
    return [];
  }

  const qualityPresets: Array<Omit<PlaybackQualityOption, "id">> = [
    {
      label: "4K",
      subtitle: "HLS · up to 120 Mbps",
      maxHeight: 2160,
      maxWidth: 3840,
      maxStreamingBitrate: MAX_STREAMING_BITRATE,
    },
    {
      label: "1080p",
      subtitle: "HLS · up to 35 Mbps",
      maxHeight: 1080,
      maxWidth: 1920,
      maxStreamingBitrate: 35_000_000,
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
    .filter(
      (option) =>
        option.maxHeight !== undefined && option.maxHeight <= sourceHeight,
    )
    .map((option) => {
      const maxHeight = option.maxHeight;
      const maxWidth =
        option.maxWidth && sourceWidth && sourceHeight
          ? Math.min(
              option.maxWidth,
              Math.round(
                (sourceWidth / sourceHeight) * (maxHeight ?? sourceHeight),
              ),
            )
          : option.maxWidth;

      return {
        ...option,
        id: `hls-${maxHeight ?? "auto"}-${option.maxStreamingBitrate}`,
        maxWidth,
      };
    });
}

function resolveTranscodingUrl(
  mediaSource: JellyfinMediaSource,
): string | null {
  const session = requireAuthSession();

  if (!mediaSource.TranscodingUrl) {
    return null;
  }

  return makePlaybackUrlAbsolute(
    mediaSource.TranscodingUrl,
    session.serverUrl,
    session.accessToken,
  );
}

function isHlsUrl(
  playbackUrl: string,
  mediaSource?: JellyfinMediaSource,
): boolean {
  const transcodingContainer = mediaSource?.TranscodingContainer?.toLowerCase();

  return (
    playbackUrl.toLowerCase().includes(".m3u8") ||
    mediaSource?.TranscodingSubProtocol?.toLowerCase() === "hls" ||
    transcodingContainer === "ts" ||
    transcodingContainer === "mp4"
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
  hlsKind?: PlaybackSourceCandidate["hlsKind"],
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
    hlsKind,
    label: mode,
    mediaSource,
    playbackInfo,
    reason,
    transcodeReasons: mediaSource.TranscodingReasons ?? [],
    directPlayError: mediaSource.DirectPlayError,
    priority,
  };
}

function getPlaybackUrlType(candidate: PlaybackSourceCandidate): string {
  const url = candidate.url.toLowerCase();

  if (candidate.hlsKind === "direct" || url.includes("/stream.")) {
    return "Direct stream URL";
  }

  if (url.includes("/master.m3u8") && candidate.hlsKind === "audio-transcode") {
    return "master.m3u8 audio-transcode";
  }

  if (url.includes("/master.m3u8")) {
    return "master.m3u8 HLS";
  }

  if (url.includes("/main.m3u8")) {
    return "main.m3u8 forced transcode";
  }

  if (candidate.hlsKind === "jellyfin-transcoding-url") {
    return "Jellyfin returned TranscodingUrl";
  }

  return "Unknown";
}

function getPlaybackCandidateDebug(candidate: PlaybackSourceCandidate) {
  return {
    id: candidate.id,
    mode: candidate.mode,
    isHls: candidate.isHls,
    hlsKind: candidate.hlsKind,
    priority: candidate.priority,
    reason: candidate.reason,
    urlType: getPlaybackUrlType(candidate),
    url: redactPlaybackUrl(candidate.url),
  };
}

export function buildPlaybackCandidates(
  itemId: string,
  playbackInfo: JellyfinPlaybackInfoResponse,
): PlaybackSourceCandidate[] {
  const sources = playbackInfo.MediaSources ?? [];
  const candidates: PlaybackSourceCandidate[] = [];

  sources.forEach((mediaSource, sourceIndex) => {
    const canDirectPlay = Boolean(
      mediaSource.SupportsDirectPlay || mediaSource.SupportsDirectStream,
    );
    const browserPlay = getBrowserCanPlayResult(mediaSource);
    const browserCanPlay = browserPlay.browserCanPlay;
    const mimeType = browserPlay.mimeType;
    const playSessionId = playbackInfo.PlaySessionId;
    const transcodingUrl = resolveTranscodingUrl(mediaSource);
    const mediaSourceCandidates: PlaybackSourceCandidate[] = [];
    const prefersFmp4Hls = shouldPreferFmp4Hls(mediaSource);
    const offerAudioTranscodeHls = shouldOfferAudioTranscodeHls(mediaSource);
    let directPriority: number;
    let streamCopyHlsPriority: number;
    let audioTranscodePriority: number;
    let returnedTranscodingUrlPriority: number;
    let forcedTranscodePriority: number;

    if (browserCanPlay) {
      directPriority = 3 + sourceIndex;
      streamCopyHlsPriority = 20 + sourceIndex;
      audioTranscodePriority = 30 + sourceIndex;
      returnedTranscodingUrlPriority = 50 + sourceIndex;
      forcedTranscodePriority = 70 + sourceIndex;
    } else if (offerAudioTranscodeHls) {
      audioTranscodePriority = 5 + sourceIndex;
      returnedTranscodingUrlPriority = 6 + sourceIndex;
      forcedTranscodePriority = 7 + sourceIndex;
      directPriority = 85 + sourceIndex;
      streamCopyHlsPriority = 90 + sourceIndex;
    } else if (prefersFmp4Hls) {
      streamCopyHlsPriority = 6 + sourceIndex;
      returnedTranscodingUrlPriority = 7 + sourceIndex;
      forcedTranscodePriority = 8 + sourceIndex;
      directPriority = 85 + sourceIndex;
      audioTranscodePriority = 95 + sourceIndex;
    } else {
      returnedTranscodingUrlPriority = 5 + sourceIndex;
      forcedTranscodePriority = 6 + sourceIndex;
      directPriority = 85 + sourceIndex;
      streamCopyHlsPriority = 90 + sourceIndex;
      audioTranscodePriority = 95 + sourceIndex;
    }

    console.info("[Seyirlik Playback] Browser media support check", {
      mediaSourceId: mediaSource.Id,
      container: normalizeContainer(mediaSource.Container),
      videoCodec: getVideoCodecForMediaSource(mediaSource),
      audioCodec: getAudioCodecForMediaSource(mediaSource),
      mimeType,
      canPlayType: browserPlay.support,
      browserCanPlay,
      isSafariBrowser: isSafariBrowser(),
      isAppleBrowser: isAppleBrowser(),
      prefersFmp4Hls,
      offerAudioTranscodeHls,
      reason: browserPlay.reason,
      supportsDirectPlay: mediaSource.SupportsDirectPlay,
      supportsDirectStream: mediaSource.SupportsDirectStream,
      supportsTranscoding: mediaSource.SupportsTranscoding,
    });

    if (transcodingUrl) {
      mediaSourceCandidates.push(
        createPlaybackCandidate(
          itemId,
          mediaSource,
          "Transcoding",
          transcodingUrl,
          playSessionId,
          returnedTranscodingUrlPriority,
          "Jellyfin returned a transcoding URL from PlaybackInfo.",
          isHlsUrl(transcodingUrl, mediaSource)
            ? "application/vnd.apple.mpegurl"
            : undefined,
          playbackInfo,
          "jellyfin-transcoding-url",
        ),
      );
    }

    if (mediaSource.SupportsTranscoding && mediaSource.Id) {
      if (offerAudioTranscodeHls) {
        mediaSourceCandidates.push(
          createPlaybackCandidate(
            itemId,
            mediaSource,
            "Transcoding",
            buildAudioTranscodeHlsUrl(itemId, mediaSource, playSessionId),
            playSessionId,
            audioTranscodePriority,
            browserCanPlay
              ? "Audio-only HLS fallback kept behind browser-safe direct playback."
              : "Audio-only HLS fallback prioritized to preserve the original H.264 SDR video while converting audio to AAC.",
            "application/vnd.apple.mpegurl",
            playbackInfo,
            "audio-transcode",
          ),
        );
      }

      mediaSourceCandidates.push(
        createPlaybackCandidate(
          itemId,
          mediaSource,
          "Transcoding",
          buildForcedTranscodeHlsUrl(itemId, mediaSource, playSessionId),
          playSessionId,
          forcedTranscodePriority,
          browserCanPlay
            ? "Forced H.264/AAC HLS fallback kept after browser-safe direct playback."
            : prefersFmp4Hls
              ? "Forced H.264/AAC HLS fallback kept behind fMP4 stream-copy HLS for HEVC/AV1."
              : "Forced H.264/AAC HLS fallback prioritized because direct playback is risky.",
          "application/vnd.apple.mpegurl",
          playbackInfo,
          "forced-transcode",
        ),
      );

      const hlsMode: PlaybackMode = canDirectPlay
        ? "DirectStream"
        : "Transcoding";

      mediaSourceCandidates.push(
        createPlaybackCandidate(
          itemId,
          mediaSource,
          hlsMode,
          buildStreamCopyHlsUrl(itemId, mediaSource, playSessionId),
          playSessionId,
          streamCopyHlsPriority,
          prefersFmp4Hls
            ? "Built a Jellyfin fMP4 HLS stream-copy candidate for HEVC/AV1."
            : canDirectPlay
              ? "Built a Jellyfin HLS stream-copy candidate from PlaybackInfo media source data."
              : "Built a Jellyfin HLS fallback URL from PlaybackInfo media source data.",
          "application/vnd.apple.mpegurl",
          playbackInfo,
          "stream-copy",
        ),
      );
    }

    if (canDirectPlay) {
      const mode: PlaybackMode = mediaSource.SupportsDirectPlay
        ? "DirectPlay"
        : "DirectStream";
      mediaSourceCandidates.push(
        createPlaybackCandidate(
          itemId,
          mediaSource,
          mode,
          buildDirectStreamUrl(itemId, mediaSource, playSessionId),
          playSessionId,
          directPriority,
          browserCanPlay
            ? "Container and codecs look browser-compatible."
            : "Direct URL kept as a last resort because this container or codec is risky in browsers.",
          mimeType,
          playbackInfo,
          "direct",
        ),
      );
    }

    console.info(
      "[Seyirlik Playback] Candidate list for media source",
      mediaSourceCandidates
        .slice()
        .sort((left, right) => left.priority - right.priority)
        .map(getPlaybackCandidateDebug),
    );

    candidates.push(...mediaSourceCandidates);
  });

  return candidates.sort((left, right) => left.priority - right.priority);
}

function getTokenForUrl(): string | undefined {
  return getAuthSession()?.accessToken;
}

export function getPrimaryImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 500,
): string {
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    return "";
  }

  return buildJellyfinUrl(
    serverUrl,
    `/Items/${encodeURIComponent(itemId)}/Images/Primary`,
    {
      maxWidth,
      quality: 90,
      tag,
      api_key: getTokenForUrl(),
    },
  );
}

export function getLogoImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 900,
): string {
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    return "";
  }

  return buildJellyfinUrl(
    serverUrl,
    `/Items/${encodeURIComponent(itemId)}/Images/Logo`,
    {
      maxWidth,
      quality: 95,
      tag,
      api_key: getTokenForUrl(),
    },
  );
}

export function getBackdropImageUrl(
  itemId: string,
  tag?: string,
  maxWidth = 1600,
): string {
  const serverUrl = getServerUrl();

  if (!serverUrl) {
    return "";
  }

  return buildJellyfinUrl(
    serverUrl,
    `/Items/${encodeURIComponent(itemId)}/Images/Backdrop`,
    {
      maxWidth,
      quality: 88,
      imageIndex: 0,
      tag,
      api_key: getTokenForUrl(),
    },
  );
}

export function getStreamUrl(itemId: string): string {
  const session = requireAuthSession();

  // Legacy direct URL helper kept for compatibility. The player now uses
  // PlaybackInfo candidates so it can fall back to Jellyfin HLS/transcoding.
  return buildJellyfinUrl(
    session.serverUrl,
    `/Videos/${encodeURIComponent(itemId)}/stream`,
    {
      static: true,
      deviceId: session.deviceId,
      api_key: session.accessToken,
    },
  );
}

export function ticksFromSeconds(seconds: number): number {
  return Math.max(0, Math.floor(seconds * 10_000_000));
}

function getPlayMethod(
  source: PlaybackSourceCandidate,
): PlaybackMode | "Transcode" {
  return source.mode === "Transcoding" ? "Transcode" : source.mode;
}

export async function reportPlaybackStart(
  source: PlaybackSourceCandidate,
  positionTicks = 0,
): Promise<void> {
  await requestJson<void>("/Sessions/Playing", {
    method: "POST",
    body: {
      ItemId: source.itemId,
      MediaSourceId: source.mediaSourceId,
      PlaySessionId: source.playSessionId,
      PositionTicks: positionTicks,
      CanSeek: true,
      PlayMethod: getPlayMethod(source),
    },
  });
}

export async function reportPlaybackProgress(
  source: PlaybackSourceCandidate,
  positionTicks: number,
  isPaused: boolean,
): Promise<void> {
  await requestJson<void>("/Sessions/Playing/Progress", {
    method: "POST",
    body: {
      ItemId: source.itemId,
      MediaSourceId: source.mediaSourceId,
      PlaySessionId: source.playSessionId,
      PositionTicks: positionTicks,
      IsPaused: isPaused,
      CanSeek: true,
      PlayMethod: getPlayMethod(source),
    },
  });
}

export async function reportPlaybackStopped(
  source: PlaybackSourceCandidate,
  positionTicks: number,
): Promise<void> {
  await requestJson<void>("/Sessions/Playing/Stopped", {
    method: "POST",
    body: {
      ItemId: source.itemId,
      MediaSourceId: source.mediaSourceId,
      PlaySessionId: source.playSessionId,
      PositionTicks: positionTicks,
    },
  });
}

export function reportPlaybackStoppedBeforeUnload(
  source: PlaybackSourceCandidate,
  positionTicks: number,
): void {
  try {
    const serverUrl = getServerUrl();

    if (!serverUrl) {
      return;
    }

    const authHeaders = getAuthHeaders();

    if (!authHeaders["X-Emby-Token"]) {
      return;
    }

    const url = buildJellyfinUrl(serverUrl, "/Sessions/Playing/Stopped");

    const body = JSON.stringify({
      ItemId: source.itemId,
      MediaSourceId: source.mediaSourceId,
      PlaySessionId: source.playSessionId,
      PositionTicks: positionTicks,
    });

    void fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...authHeaders,
      },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Browser is closing/navigating away. There is no safe recovery here.
  }
}

export async function reportAuditPlaybackStart(
  source: PlaybackSourceCandidate,
): Promise<void> {
  await requestJson<void>("/Sessions/Playing", {
    method: "POST",
    body: {
      ItemId: source.itemId,
      MediaSourceId: source.mediaSourceId,
      PlaySessionId: source.playSessionId,
      PositionTicks: 0,
      CanSeek: true,
      PlayMethod: source.mode === "Transcoding" ? "Transcode" : source.mode,
    },
  });
}

export async function reportAuditPlaybackProgress(
  source: PlaybackSourceCandidate,
): Promise<void> {
  await requestJson<void>("/Sessions/Playing/Progress", {
    method: "POST",
    body: {
      ItemId: source.itemId,
      MediaSourceId: source.mediaSourceId,
      PlaySessionId: source.playSessionId,
      PositionTicks: 0,
      IsPaused: false,
      CanSeek: true,
      PlayMethod: source.mode === "Transcoding" ? "Transcode" : source.mode,
    },
  });
}

export async function reportAuditPlaybackStopped(
  source: PlaybackSourceCandidate,
): Promise<void> {
  await requestJson<void>("/Sessions/Playing/Stopped", {
    method: "POST",
    body: {
      ItemId: source.itemId,
      MediaSourceId: source.mediaSourceId,
      PlaySessionId: source.playSessionId,
      PositionTicks: 0,
    },
  });
}

export async function stopActiveTranscodeSession(
  playSessionId?: string,
): Promise<void> {
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
