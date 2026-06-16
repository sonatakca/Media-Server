export type TmdbArtworkKind = "poster" | "backdrop" | "landscape" | "logo";
export type TmdbMediaType = "movie" | "tv";
export type TmdbImageLanguage = "en" | "tr" | null;
export type TmdbEpisodeThumbnailLanguage = TmdbImageLanguage;

export interface TmdbSearchResult {
  id: number;
  mediaType: TmdbMediaType;
  title: string;
  originalTitle: string | null;
  overview: string | null;
  year: number | null;
  date: string | null;
  posterPath: string | null;
  backdropPath: string | null;
  posterPreviewUrl: string | null;
  backdropPreviewUrl: string | null;
  voteAverage: number | null;
  popularity: number | null;
}

export interface TmdbLocalizedMetadata {
  tmdbId: number;
  mediaType: TmdbMediaType;
  language: "en" | "tr";
  title: string | null;
  overview: string | null;
  genres: string[];
}

interface LocalizedMetadataResponse {
  metadata?: TmdbLocalizedMetadata;
}

export interface TmdbArtworkImage {
  id: string;
  kind: TmdbArtworkKind;
  sourceType: "poster" | "backdrop" | "logo";
  filePath: string;
  previewUrl: string;
  fullUrl: string;
  language: TmdbImageLanguage;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  voteAverage: number | null;
  voteCount: number | null;
  targetFileName: string;
}

export interface TmdbArtworkApplyResult {
  itemId: string;
  kind: TmdbArtworkKind;
  filePath: string;
  targetFileName: string;
  targetPath: string;
  bytes: number;
}

export interface TmdbEpisodeThumbnail {
  id: string;
  filePath: string;
  previewUrl: string;
  fullUrl: string;
  language: TmdbImageLanguage;
  width: number | null;
  height: number | null;
  aspectRatio: number | null;
  voteAverage: number | null;
  voteCount: number | null;
}

export interface TmdbEpisodeMetadata {
  seasonNumber: number;
  episodeNumber: number;
  name: Record<"en" | "tr", string | null>;
  overview: Record<"en" | "tr", string | null>;
  thumbnail: TmdbEpisodeThumbnail | null;
}

interface SearchResponse {
  results?: TmdbSearchResult[];
}

interface ImagesResponse {
  images?: TmdbArtworkImage[];
  languageFilter?: Array<"en" | "tr" | null>;
  targetFileName?: string;
}

interface EpisodeMetadataResponse {
  seasonNumber?: number;
  thumbnailLanguage?: TmdbEpisodeThumbnailLanguage;
  episodes?: TmdbEpisodeMetadata[];
}

const ARTWORK_REQUEST_TIMEOUT_MS = 15_000;
const EPISODE_METADATA_REQUEST_TIMEOUT_MS = 45_000;

function getBackendUrl(): string | null {
  const rawUrl = import.meta.env.VITE_SEYIRLIK_PLAYBACK_BACKEND_URL;

  if (!rawUrl) {
    return null;
  }

  return rawUrl.replace(/\/+$/, "");
}

function buildArtworkEndpoint(baseUrl: string, path: string): string {
  const normalizedPath = path.replace(/^\/+/, "");

  if (baseUrl.endsWith("/api/tmdb-artwork")) {
    return `${baseUrl}/${normalizedPath}`;
  }

  return `${baseUrl}/api/tmdb-artwork/${normalizedPath}`;
}

function appendParams(
  endpoint: string,
  params: Record<string, string | number | null | undefined>,
): string {
  const url = new URL(endpoint);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string };
      message?: string;
    };

    return (
      payload.error?.message ??
      payload.message ??
      `TMDB artwork request failed with ${response.status}.`
    );
  } catch {
    return `TMDB artwork request failed with ${response.status}.`;
  }
}

function getCurrentOrigin(): string {
  if (typeof window === "undefined") {
    return "the current frontend origin";
  }

  return window.location.origin;
}

async function requestArtworkJson<TResponse>(
  path: string,
  options: {
    method?: "GET" | "POST";
    params?: Record<string, string | number | null | undefined>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<TResponse> {
  const baseUrl = getBackendUrl();

  if (!baseUrl) {
    throw new Error(
      "TMDB artwork backend is not configured. Set VITE_SEYIRLIK_PLAYBACK_BACKEND_URL.",
    );
  }

  const endpoint = appendParams(
    buildArtworkEndpoint(baseUrl, path),
    options.params ?? {},
  );
  const abortController = new AbortController();
  const requestTimeoutMs = options.timeoutMs ?? ARTWORK_REQUEST_TIMEOUT_MS;
  const timeoutId = globalThis.setTimeout(() => {
    abortController.abort();
  }, requestTimeoutMs);
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: abortController.signal,
    });
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new Error(
        `TMDB artwork backend did not respond within ${Math.round(
          requestTimeoutMs / 1000,
        )} seconds. Check that ${baseUrl} is reachable from this browser.`,
      );
    }

    if (error instanceof TypeError) {
      throw new Error(
        `Could not reach the TMDB artwork backend at ${baseUrl}. Make sure npm run playback:backend is running and SEYIRLIK_ALLOWED_ORIGINS includes ${getCurrentOrigin()}.`,
      );
    }

    throw error;
  } finally {
    globalThis.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as TResponse;
}

export function isTmdbArtworkBackendConfigured(): boolean {
  return Boolean(getBackendUrl());
}

export async function searchTmdbArtwork(params: {
  mediaType: TmdbMediaType;
  query: string;
  year?: number;
  language: "en" | "tr";
}): Promise<TmdbSearchResult[]> {
  const response = await requestArtworkJson<SearchResponse>("search", {
    params: {
      mediaType: params.mediaType,
      query: params.query,
      year: params.year,
      language: params.language,
    },
  });

  return response.results ?? [];
}

export async function getTmdbLocalizedMetadata(params: {
  mediaType: TmdbMediaType;
  tmdbId: number;
  language: "en" | "tr";
}): Promise<TmdbLocalizedMetadata | null> {
  const response = await requestArtworkJson<LocalizedMetadataResponse>(
    "metadata",
    {
      params: {
        mediaType: params.mediaType,
        tmdbId: params.tmdbId,
        language: params.language,
      },
    },
  );

  return response.metadata ?? null;
}

export async function getTmdbArtworkImages(params: {
  mediaType: TmdbMediaType;
  tmdbId: number;
  kind: TmdbArtworkKind;
  language: "en" | "tr";
}): Promise<TmdbArtworkImage[]> {
  const response = await requestArtworkJson<ImagesResponse>("images", {
    params: {
      mediaType: params.mediaType,
      tmdbId: params.tmdbId,
      kind: params.kind,
      language: params.language,
    },
  });

  return response.images ?? [];
}

export async function getTmdbEpisodeMetadata(params: {
  tmdbId: number;
  seasonNumber: number;
  thumbnailLanguage: TmdbEpisodeThumbnailLanguage;
}): Promise<TmdbEpisodeMetadata[]> {
  const response = await requestArtworkJson<EpisodeMetadataResponse>(
    "episode-metadata",
    {
      params: {
        tmdbId: params.tmdbId,
        seasonNumber: params.seasonNumber,
        thumbnailLanguage: params.thumbnailLanguage ?? "none",
      },
      timeoutMs: EPISODE_METADATA_REQUEST_TIMEOUT_MS,
    },
  );

  return response.episodes ?? [];
}

export async function applyTmdbArtwork(params: {
  itemId: string;
  kind: TmdbArtworkKind;
  filePath: string;
}): Promise<TmdbArtworkApplyResult> {
  return requestArtworkJson<TmdbArtworkApplyResult>("apply", {
    method: "POST",
    body: params,
  });
}
