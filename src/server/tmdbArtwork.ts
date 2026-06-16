import { constants } from "node:fs";
import {
  access,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeJellyfinServerUrl } from "./jellyfinMediaResolver";
import { assertMediaRootDirectory, isPathInsideRoot } from "./pathSecurity";

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export type TmdbArtworkKind = "poster" | "backdrop" | "landscape" | "logo";
export type TmdbMediaType = "movie" | "tv";
export type TmdbImageLanguage = "en" | "tr" | null;

export interface TmdbArtworkRequestHandlerOptions {
  mediaRoot: string;
  tmdbApiKey?: string;
  jellyfinServerUrl?: string;
  jellyfinApiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  basePath?: string;
}

interface JellyfinItemResponse {
  Id?: unknown;
  Type?: unknown;
  MediaType?: unknown;
  Path?: unknown;
  MediaSources?: unknown;
  ProviderIds?: unknown;
}

interface JellyfinItemsResponse {
  Items?: unknown;
}

interface JellyfinMediaSource {
  Protocol?: unknown;
  Path?: unknown;
}

interface TmdbSearchResponse {
  results?: unknown;
}

interface TmdbMovieSearchResult {
  id?: unknown;
  title?: unknown;
  original_title?: unknown;
  overview?: unknown;
  poster_path?: unknown;
  backdrop_path?: unknown;
  release_date?: unknown;
  vote_average?: unknown;
  popularity?: unknown;
}

interface TmdbTvSearchResult {
  id?: unknown;
  name?: unknown;
  original_name?: unknown;
  overview?: unknown;
  poster_path?: unknown;
  backdrop_path?: unknown;
  first_air_date?: unknown;
  vote_average?: unknown;
  popularity?: unknown;
}

interface TmdbImageResponse {
  backdrops?: unknown;
  logos?: unknown;
  posters?: unknown;
}

interface TmdbSeasonDetailsResponse {
  episodes?: unknown;
}

interface TmdbRawSeasonEpisode {
  episode_number?: unknown;
  name?: unknown;
  overview?: unknown;
  still_path?: unknown;
}

interface TmdbEpisodeImageResponse {
  stills?: unknown;
}

interface TmdbRawImage {
  aspect_ratio?: unknown;
  file_path?: unknown;
  height?: unknown;
  iso_639_1?: unknown;
  vote_average?: unknown;
  vote_count?: unknown;
  width?: unknown;
}

interface TmdbArtworkApplyBody {
  itemId?: unknown;
  kind?: unknown;
  filePath?: unknown;
}

interface NormalizedTmdbImage {
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

interface NormalizedTmdbEpisodeStill {
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

interface NormalizedTmdbSeasonEpisode {
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
}

type ErrorStatusCode = 400 | 403 | 404 | 405 | 409 | 413 | 500 | 502 | 503;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3/";
const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const TMDB_ALLOWED_IMAGE_LANGUAGES = new Set(["en", "tr"]);
const TMDB_INCLUDE_IMAGE_LANGUAGE = "en,tr,null";
const TMDB_EPISODE_STILL_CONCURRENCY = 6;
const ITEM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const TMDB_FILE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const LOCAL_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const TARGET_FILE_BY_KIND: Record<TmdbArtworkKind, string> = {
  poster: "folder.jpg",
  backdrop: "backdrop.jpg",
  landscape: "landscape.jpg",
  logo: "logo.png",
};

class TmdbArtworkRouteError extends Error {
  code: string;
  statusCode: ErrorStatusCode;

  constructor(code: string, message: string, statusCode: ErrorStatusCode) {
    super(message);
    this.name = "TmdbArtworkRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(
  response: ServerResponse,
  allowedMethods: string[],
): void {
  response.statusCode = 405;
  response.setHeader("Allow", allowedMethods.join(", "));
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "HTTP method is not allowed for this route.",
      },
    }),
  );
}

function sendRouteError(response: ServerResponse, error: unknown): void {
  const maybeError = error as Partial<TmdbArtworkRouteError> | undefined;
  const statusCode =
    typeof maybeError?.statusCode === "number" ? maybeError.statusCode : 500;
  const code =
    typeof maybeError?.code === "string"
      ? maybeError.code
      : "INTERNAL_SERVER_ERROR";
  const message =
    error instanceof Error && statusCode !== 500
      ? error.message
      : statusCode === 500
        ? "An internal TMDB artwork error occurred."
        : "TMDB artwork request failed.";

  sendJson(response, statusCode, {
    error: {
      code,
      message,
    },
  });
}

function parseJsonBody<TBody>(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<TBody> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    request.on("data", (chunk: Buffer) => {
      if (rejected) return;

      totalBytes += chunk.byteLength;

      if (totalBytes > maxBytes) {
        rejected = true;
        reject(
          new TmdbArtworkRouteError(
            "REQUEST_BODY_TOO_LARGE",
            "Request body is too large.",
            413,
          ),
        );
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (rejected) return;

      const raw = Buffer.concat(chunks).toString("utf8");

      if (!raw.trim()) {
        resolveBody({} as TBody);
        return;
      }

      try {
        resolveBody(JSON.parse(raw) as TBody);
      } catch {
        reject(
          new TmdbArtworkRouteError(
            "INVALID_JSON",
            "Request body must be valid JSON.",
            400,
          ),
        );
      }
    });
  });
}

function requireConfiguredValue(
  value: string | undefined,
  code: string,
  message: string,
): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new TmdbArtworkRouteError(code, message, 503);
  }

  return trimmed;
}

function validateItemId(value: unknown): string {
  if (typeof value !== "string" || !ITEM_ID_PATTERN.test(value.trim())) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_ITEM_ID_INVALID",
      "Jellyfin item id is invalid.",
      400,
    );
  }

  return value.trim();
}

function validateTmdbId(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;

  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) {
    throw new TmdbArtworkRouteError(
      "TMDB_ID_INVALID",
      "TMDB id must be a positive integer.",
      400,
    );
  }

  return parsed;
}

function validateSeasonNumber(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;

  if (
    typeof parsed !== "number" ||
    !Number.isInteger(parsed) ||
    parsed < 0 ||
    parsed > 1_000
  ) {
    throw new TmdbArtworkRouteError(
      "TMDB_SEASON_NUMBER_INVALID",
      "TMDB season number must be an integer between 0 and 1000.",
      400,
    );
  }

  return parsed;
}

function validateMediaType(value: unknown): TmdbMediaType {
  if (value === "movie" || value === "tv") {
    return value;
  }

  throw new TmdbArtworkRouteError(
    "TMDB_MEDIA_TYPE_INVALID",
    "TMDB media type must be movie or tv.",
    400,
  );
}

function validateArtworkKind(value: unknown): TmdbArtworkKind {
  if (
    value === "poster" ||
    value === "backdrop" ||
    value === "landscape" ||
    value === "logo"
  ) {
    return value;
  }

  throw new TmdbArtworkRouteError(
    "TMDB_ARTWORK_KIND_INVALID",
    "Artwork kind must be poster, backdrop, landscape, or logo.",
    400,
  );
}

function validateTmdbFilePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new TmdbArtworkRouteError(
      "TMDB_FILE_PATH_INVALID",
      "TMDB image file path is invalid.",
      400,
    );
  }

  const trimmed = value.trim();

  if (
    !TMDB_FILE_PATH_PATTERN.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("\\")
  ) {
    throw new TmdbArtworkRouteError(
      "TMDB_FILE_PATH_INVALID",
      "TMDB image file path is invalid.",
      400,
    );
  }

  return trimmed;
}

function normalizePreferredLanguage(value: string | null): "en" | "tr" {
  return value === "tr" ? "tr" : "en";
}

function validateEpisodeThumbnailLanguage(value: unknown): TmdbImageLanguage {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    value === "null" ||
    value === "none"
  ) {
    return null;
  }

  const normalized = normalizeImageLanguage(value);

  if (normalized === "en" || normalized === "tr") {
    return normalized;
  }

  throw new TmdbArtworkRouteError(
    "TMDB_EPISODE_THUMBNAIL_LANGUAGE_INVALID",
    "Episode thumbnail language must be English, Turkish, or no language.",
    400,
  );
}

function toTmdbLocale(language: "en" | "tr"): string {
  return language === "tr" ? "tr-TR" : "en-US";
}

function getEpisodeImageLanguageFilter(language: TmdbImageLanguage): string {
  return language ? `${language},null` : "null";
}

function normalizeImageLanguage(value: unknown): TmdbImageLanguage | undefined {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const lower = value.toLowerCase();

  if (TMDB_ALLOWED_IMAGE_LANGUAGES.has(lower)) {
    return lower as "en" | "tr";
  }

  return undefined;
}

function getString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function getNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function getInteger(value: unknown): number | null {
  const numberValue = getNumber(value);

  return numberValue !== null && Number.isInteger(numberValue)
    ? numberValue
    : null;
}

function getYear(value: unknown): number | null {
  const raw = getString(value);
  const year = raw?.slice(0, 4);
  const parsed = year ? Number(year) : NaN;

  return Number.isInteger(parsed) ? parsed : null;
}

function getTargetFileName(kind: TmdbArtworkKind): string {
  return TARGET_FILE_BY_KIND[kind];
}

function getSourceTypeForKind(
  kind: TmdbArtworkKind,
): "poster" | "backdrop" | "logo" {
  if (kind === "poster") return "poster";
  if (kind === "logo") return "logo";
  return "backdrop";
}

function buildImageUrl(size: string, filePath: string): string {
  return `${TMDB_IMAGE_BASE_URL}/${size}${filePath}`;
}

function getSafeTmdbFilePath(value: unknown): string | null {
  const filePath = getString(value);

  if (
    !filePath ||
    !TMDB_FILE_PATH_PATTERN.test(filePath) ||
    filePath.includes("..") ||
    filePath.includes("\\")
  ) {
    return null;
  }

  return filePath;
}

function getSearchYearParam(mediaType: TmdbMediaType): string {
  return mediaType === "movie" ? "primary_release_year" : "first_air_date_year";
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: abortController.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TmdbArtworkRouteError(
        "UPSTREAM_TIMEOUT",
        "The upstream artwork request timed out.",
        502,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestTmdbJson<TResponse>(
  pathName: string,
  params: Record<string, string>,
  options: {
    apiKey: string;
    fetchImpl: FetchLike;
    timeoutMs: number;
  },
): Promise<TResponse> {
  const requestUrl = new URL(pathName.replace(/^\/+/, ""), TMDB_API_BASE_URL);

  requestUrl.searchParams.set("api_key", options.apiKey);

  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      requestUrl.searchParams.set(key, value);
    }
  });

  const response = await fetchWithTimeout(
    options.fetchImpl,
    requestUrl,
    {
      headers: {
        Accept: "application/json",
      },
    },
    options.timeoutMs,
  );

  if (response.status === 401 || response.status === 403) {
    throw new TmdbArtworkRouteError(
      "TMDB_AUTH_FAILED",
      "TMDB rejected the configured API key.",
      502,
    );
  }

  if (response.status === 404) {
    throw new TmdbArtworkRouteError(
      "TMDB_NOT_FOUND",
      "TMDB item was not found.",
      404,
    );
  }

  if (!response.ok) {
    throw new TmdbArtworkRouteError(
      "TMDB_UNAVAILABLE",
      "TMDB request failed.",
      502,
    );
  }

  return (await response.json()) as TResponse;
}

async function fetchJellyfinItem(
  itemId: string,
  options: {
    jellyfinServerUrl: string;
    apiKey: string;
    fetchImpl: FetchLike;
    timeoutMs: number;
  },
): Promise<JellyfinItemResponse> {
  const requestUrl = new URL(
    "Items",
    `${normalizeJellyfinServerUrl(options.jellyfinServerUrl)}/`,
  );

  requestUrl.searchParams.set("Ids", itemId);
  requestUrl.searchParams.set("Fields", "Path,MediaSources,ProviderIds");
  requestUrl.searchParams.set("Limit", "1");

  const response = await fetchWithTimeout(
    options.fetchImpl,
    requestUrl,
    {
      headers: {
        Accept: "application/json",
        "X-Emby-Token": options.apiKey,
      },
    },
    options.timeoutMs,
  );

  if (response.status === 401 || response.status === 403) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_AUTH_FAILED",
      "Jellyfin rejected the configured backend API key.",
      502,
    );
  }

  if (!response.ok) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_UNAVAILABLE",
      "Jellyfin item lookup failed.",
      502,
    );
  }

  const payload = (await response.json()) as JellyfinItemsResponse;

  if (!Array.isArray(payload.Items) || payload.Items.length === 0) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_ITEM_NOT_FOUND",
      "Jellyfin item was not found.",
      404,
    );
  }

  const item = payload.Items[0];

  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_RESPONSE_INVALID",
      "Jellyfin returned an invalid item response.",
      502,
    );
  }

  return item as JellyfinItemResponse;
}

function normalizeSearchResult(
  mediaType: TmdbMediaType,
  value: unknown,
): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const item = value as TmdbMovieSearchResult & TmdbTvSearchResult;
  const id = getNumber(item.id);

  if (!id || !Number.isInteger(id)) {
    return null;
  }

  const title =
    mediaType === "movie" ? getString(item.title) : getString(item.name);
  const originalTitle =
    mediaType === "movie"
      ? getString(item.original_title)
      : getString(item.original_name);

  if (!title) {
    return null;
  }

  const date =
    mediaType === "movie"
      ? getString(item.release_date)
      : getString(item.first_air_date);

  return {
    id,
    mediaType,
    title,
    originalTitle,
    overview: getString(item.overview),
    year: getYear(date),
    date,
    posterPath: getString(item.poster_path),
    backdropPath: getString(item.backdrop_path),
    posterPreviewUrl: getString(item.poster_path)
      ? buildImageUrl("w342", getString(item.poster_path)!)
      : null,
    backdropPreviewUrl: getString(item.backdrop_path)
      ? buildImageUrl("w780", getString(item.backdrop_path)!)
      : null,
    voteAverage: getNumber(item.vote_average),
    popularity: getNumber(item.popularity),
  };
}

function compareImages(
  preferredLanguage: "en" | "tr",
  kind: TmdbArtworkKind,
  left: NormalizedTmdbImage,
  right: NormalizedTmdbImage,
): number {
  const languageRank = (image: NormalizedTmdbImage) => {
    if (kind === "backdrop" || kind === "landscape") {
      if (image.language === null) return 0;
      if (image.language === preferredLanguage) return 1;
      return 2;
    }

    if (image.language === preferredLanguage) return 0;
    if (image.language !== null) return 1;
    return 2;
  };
  const leftLanguageRank = languageRank(left);
  const rightLanguageRank = languageRank(right);

  if (leftLanguageRank !== rightLanguageRank) {
    return leftLanguageRank - rightLanguageRank;
  }

  const voteAverageDelta = (right.voteAverage ?? 0) - (left.voteAverage ?? 0);

  if (voteAverageDelta !== 0) {
    return voteAverageDelta;
  }

  const voteCountDelta = (right.voteCount ?? 0) - (left.voteCount ?? 0);

  if (voteCountDelta !== 0) {
    return voteCountDelta;
  }

  const rightArea = (right.width ?? 0) * (right.height ?? 0);
  const leftArea = (left.width ?? 0) * (left.height ?? 0);

  return rightArea - leftArea;
}

function normalizeImages(
  response: TmdbImageResponse,
  kind: TmdbArtworkKind,
  preferredLanguage: "en" | "tr",
): NormalizedTmdbImage[] {
  const sourceType = getSourceTypeForKind(kind);
  const rawList =
    sourceType === "poster"
      ? response.posters
      : sourceType === "logo"
        ? response.logos
        : response.backdrops;

  if (!Array.isArray(rawList)) {
    return [];
  }

  const seenFilePaths = new Set<string>();
  const normalizedImages: NormalizedTmdbImage[] = [];

  for (const rawImage of rawList) {
    if (!rawImage || typeof rawImage !== "object" || Array.isArray(rawImage)) {
      continue;
    }

    const image = rawImage as TmdbRawImage;
    const filePath = getString(image.file_path);
    const language = normalizeImageLanguage(image.iso_639_1);

    if (!filePath || language === undefined || seenFilePaths.has(filePath)) {
      continue;
    }

    seenFilePaths.add(filePath);

    normalizedImages.push({
      id: `${kind}:${filePath}`,
      kind,
      sourceType,
      filePath,
      previewUrl: buildImageUrl(
        sourceType === "poster" ? "w342" : "w780",
        filePath,
      ),
      fullUrl: buildImageUrl("original", filePath),
      language,
      width: getNumber(image.width),
      height: getNumber(image.height),
      aspectRatio: getNumber(image.aspect_ratio),
      voteAverage: getNumber(image.vote_average),
      voteCount: getNumber(image.vote_count),
      targetFileName: getTargetFileName(kind),
    });
  }

  return normalizedImages.sort((left, right) =>
    compareImages(preferredLanguage, kind, left, right),
  );
}

function compareEpisodeStills(
  preferredLanguage: TmdbImageLanguage,
  left: NormalizedTmdbEpisodeStill,
  right: NormalizedTmdbEpisodeStill,
): number {
  const languageRank = (image: NormalizedTmdbEpisodeStill) => {
    if (preferredLanguage === null) {
      return image.language === null ? 0 : 1;
    }

    if (image.language === preferredLanguage) return 0;
    if (image.language === null) return 1;
    return 2;
  };
  const leftLanguageRank = languageRank(left);
  const rightLanguageRank = languageRank(right);

  if (leftLanguageRank !== rightLanguageRank) {
    return leftLanguageRank - rightLanguageRank;
  }

  const voteAverageDelta = (right.voteAverage ?? 0) - (left.voteAverage ?? 0);

  if (voteAverageDelta !== 0) {
    return voteAverageDelta;
  }

  const voteCountDelta = (right.voteCount ?? 0) - (left.voteCount ?? 0);

  if (voteCountDelta !== 0) {
    return voteCountDelta;
  }

  const rightArea = (right.width ?? 0) * (right.height ?? 0);
  const leftArea = (left.width ?? 0) * (left.height ?? 0);

  return rightArea - leftArea;
}

function createEpisodeStill(
  filePath: string,
  language: TmdbImageLanguage,
  source: Partial<TmdbRawImage> = {},
): NormalizedTmdbEpisodeStill {
  return {
    id: `episode-still:${filePath}`,
    filePath,
    previewUrl: buildImageUrl("w780", filePath),
    fullUrl: buildImageUrl("original", filePath),
    language,
    width: getNumber(source.width),
    height: getNumber(source.height),
    aspectRatio: getNumber(source.aspect_ratio),
    voteAverage: getNumber(source.vote_average),
    voteCount: getNumber(source.vote_count),
  };
}

function normalizeEpisodeStills(
  response: TmdbEpisodeImageResponse,
  preferredLanguage: TmdbImageLanguage,
): NormalizedTmdbEpisodeStill[] {
  if (!Array.isArray(response.stills)) {
    return [];
  }

  const seenFilePaths = new Set<string>();
  const stills: NormalizedTmdbEpisodeStill[] = [];

  for (const rawStill of response.stills) {
    if (!rawStill || typeof rawStill !== "object" || Array.isArray(rawStill)) {
      continue;
    }

    const still = rawStill as TmdbRawImage;
    const filePath = getSafeTmdbFilePath(still.file_path);
    const language = normalizeImageLanguage(still.iso_639_1);

    if (!filePath || language === undefined || seenFilePaths.has(filePath)) {
      continue;
    }

    seenFilePaths.add(filePath);
    stills.push(createEpisodeStill(filePath, language, still));
  }

  return stills.sort((left, right) =>
    compareEpisodeStills(preferredLanguage, left, right),
  );
}

function normalizeSeasonEpisodes(
  response: TmdbSeasonDetailsResponse,
): Map<number, NormalizedTmdbSeasonEpisode> {
  const episodes = new Map<number, NormalizedTmdbSeasonEpisode>();

  if (!Array.isArray(response.episodes)) {
    return episodes;
  }

  for (const rawEpisode of response.episodes) {
    if (
      !rawEpisode ||
      typeof rawEpisode !== "object" ||
      Array.isArray(rawEpisode)
    ) {
      continue;
    }

    const episode = rawEpisode as TmdbRawSeasonEpisode;
    const episodeNumber = getInteger(episode.episode_number);

    if (episodeNumber === null || episodeNumber <= 0) {
      continue;
    }

    episodes.set(episodeNumber, {
      episodeNumber,
      name: getString(episode.name),
      overview: getString(episode.overview),
      stillPath: getSafeTmdbFilePath(episode.still_path),
    });
  }

  return episodes;
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  mapper: (item: TItem, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(concurrency, 1), items.length) },
      () => worker(),
    ),
  );

  return results;
}

async function fetchEpisodeStill(
  seriesId: number,
  seasonNumber: number,
  episodeNumber: number,
  thumbnailLanguage: TmdbImageLanguage,
  options: {
    apiKey: string;
    fetchImpl: FetchLike;
    timeoutMs: number;
  },
): Promise<NormalizedTmdbEpisodeStill | null> {
  try {
    const payload = await requestTmdbJson<TmdbEpisodeImageResponse>(
      `/tv/${seriesId}/season/${seasonNumber}/episode/${episodeNumber}/images`,
      {
        language: toTmdbLocale(thumbnailLanguage ?? "en"),
        include_image_language: getEpisodeImageLanguageFilter(
          thumbnailLanguage,
        ),
      },
      options,
    );
    const stills = normalizeEpisodeStills(payload, thumbnailLanguage);

    return stills[0] ?? null;
  } catch {
    return null;
  }
}

function getPathValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed ? trimmed : null;
}

function isLocalFilesystemPath(candidatePath: string): boolean {
  return (
    !LOCAL_URL_PATTERN.test(candidatePath) &&
    (path.isAbsolute(candidatePath) ||
      path.win32.isAbsolute(candidatePath) ||
      path.posix.isAbsolute(candidatePath))
  );
}

function getFileMediaSourcePaths(item: JellyfinItemResponse): string[] {
  if (!Array.isArray(item.MediaSources)) {
    return [];
  }

  return item.MediaSources.flatMap((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return [];
    }

    const mediaSource = source as JellyfinMediaSource;
    const protocol =
      typeof mediaSource.Protocol === "string"
        ? mediaSource.Protocol.toLowerCase()
        : "";
    const sourcePath = getPathValue(mediaSource.Path);

    return protocol === "file" && sourcePath ? [sourcePath] : [];
  });
}

function isPathInsideOrEqualRoot(realRoot: string, realCandidate: string) {
  const resolvedRoot = path.resolve(realRoot);
  const resolvedCandidate = path.resolve(realCandidate);

  if (process.platform === "win32") {
    if (
      resolvedRoot.toLocaleLowerCase("en-US") ===
      resolvedCandidate.toLocaleLowerCase("en-US")
    ) {
      return true;
    }
  } else if (resolvedRoot === resolvedCandidate) {
    return true;
  }

  return isPathInsideRoot(realRoot, realCandidate);
}

async function resolveTrustedArtworkDirectory(
  realMediaRoot: string,
  candidatePath: string,
): Promise<string> {
  if (!isLocalFilesystemPath(candidatePath)) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_LOCAL_PATH_REJECTED",
      "Jellyfin item does not expose a local path under the configured media root.",
      409,
    );
  }

  let realCandidate: string;

  try {
    realCandidate = await realpath(candidatePath);
  } catch {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_LOCAL_PATH_NOT_FOUND",
      "Jellyfin item path could not be found on disk.",
      404,
    );
  }

  if (!isPathInsideOrEqualRoot(realMediaRoot, realCandidate)) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_LOCAL_PATH_REJECTED",
      "Jellyfin item path is outside the configured media root.",
      403,
    );
  }

  const candidateStat = await stat(realCandidate);
  const directoryPath = candidateStat.isDirectory()
    ? realCandidate
    : candidateStat.isFile()
      ? path.dirname(realCandidate)
      : null;

  if (!directoryPath) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_LOCAL_PATH_REJECTED",
      "Jellyfin item path is not a file or directory.",
      409,
    );
  }

  await access(directoryPath, constants.R_OK | constants.W_OK);
  return directoryPath;
}

async function resolveArtworkTargetDirectory(
  item: JellyfinItemResponse,
  mediaRoot: string,
): Promise<string> {
  const realMediaRoot = await assertMediaRootDirectory(mediaRoot);
  const candidates = [
    getPathValue(item.Path),
    ...getFileMediaSourcePaths(item),
  ].filter((candidate): candidate is string => Boolean(candidate));
  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      return await resolveTrustedArtworkDirectory(realMediaRoot, candidate);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof TmdbArtworkRouteError) {
    throw lastError;
  }

  throw new TmdbArtworkRouteError(
    "JELLYFIN_LOCAL_PATH_MISSING",
    "Jellyfin item does not expose a local file or folder path.",
    409,
  );
}

function assertSupportedImageExtension(
  kind: TmdbArtworkKind,
  filePath: string,
): void {
  const extension = path.posix.extname(filePath).toLowerCase();

  if (kind === "logo") {
    if (extension !== ".png") {
      throw new TmdbArtworkRouteError(
        "TMDB_IMAGE_TYPE_UNSUPPORTED",
        "Logo sidecar files must be PNG images.",
        409,
      );
    }
    return;
  }

  if (extension !== ".jpg" && extension !== ".jpeg") {
    throw new TmdbArtworkRouteError(
      "TMDB_IMAGE_TYPE_UNSUPPORTED",
      "Poster, backdrop, and landscape sidecar files must be JPEG images.",
      409,
    );
  }
}

async function downloadTmdbImage(
  filePath: string,
  kind: TmdbArtworkKind,
  options: {
    fetchImpl: FetchLike;
    timeoutMs: number;
  },
): Promise<Buffer> {
  assertSupportedImageExtension(kind, filePath);

  const requestUrl = new URL(buildImageUrl("original", filePath));
  const response = await fetchWithTimeout(
    options.fetchImpl,
    requestUrl,
    {
      headers: {
        Accept: kind === "logo" ? "image/png" : "image/jpeg",
      },
    },
    options.timeoutMs,
  );

  if (!response.ok) {
    throw new TmdbArtworkRouteError(
      "TMDB_IMAGE_DOWNLOAD_FAILED",
      "TMDB image download failed.",
      502,
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength === 0) {
    throw new TmdbArtworkRouteError(
      "TMDB_IMAGE_EMPTY",
      "TMDB image download returned an empty file.",
      502,
    );
  }

  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new TmdbArtworkRouteError(
      "TMDB_IMAGE_TOO_LARGE",
      "TMDB image is too large to save as sidecar artwork.",
      413,
    );
  }

  return buffer;
}

async function writeSidecarArtwork(
  directoryPath: string,
  targetFileName: string,
  contents: Buffer,
): Promise<string> {
  const destinationPath = path.resolve(directoryPath, targetFileName);

  if (path.dirname(destinationPath) !== path.resolve(directoryPath)) {
    throw new TmdbArtworkRouteError(
      "ARTWORK_TARGET_INVALID",
      "Artwork target file is invalid.",
      400,
    );
  }

  const temporaryPath = path.join(
    directoryPath,
    `.seyirlik-${targetFileName}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(temporaryPath, contents, { mode: 0o644 });
    await rename(temporaryPath, destinationPath);
    return destinationPath;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function createTmdbArtworkRequestHandler(
  options: TmdbArtworkRequestHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  const basePath = options.basePath ?? "/api/tmdb-artwork";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const requireTmdbApiKey = () =>
    requireConfiguredValue(
      options.tmdbApiKey,
      "TMDB_API_KEY_REQUIRED",
      "SEYIRLIK_TMDB_API_KEY is required for the TMDB artwork tool.",
    );
  const requireJellyfinServerUrl = () =>
    requireConfiguredValue(
      options.jellyfinServerUrl,
      "JELLYFIN_SERVER_URL_REQUIRED",
      "SEYIRLIK_JELLYFIN_SERVER_URL is required for the TMDB artwork tool.",
    );
  const requireJellyfinApiKey = () =>
    requireConfiguredValue(
      options.jellyfinApiKey,
      "JELLYFIN_API_KEY_REQUIRED",
      "SEYIRLIK_JELLYFIN_API_KEY is required for the TMDB artwork tool.",
    );

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (!url.pathname.startsWith(basePath)) {
      return false;
    }

    try {
      if (url.pathname === `${basePath}/search`) {
        if (request.method !== "GET") {
          sendMethodNotAllowed(response, ["GET", "OPTIONS"]);
          return true;
        }

        const apiKey = requireTmdbApiKey();
        const mediaType = validateMediaType(url.searchParams.get("mediaType"));
        const query = url.searchParams.get("query")?.trim();
        const year = url.searchParams.get("year")?.trim();
        const language = normalizePreferredLanguage(
          url.searchParams.get("language"),
        );

        if (!query) {
          throw new TmdbArtworkRouteError(
            "TMDB_QUERY_REQUIRED",
            "Search query is required.",
            400,
          );
        }

        const params: Record<string, string> = {
          query,
          include_adult: "false",
          language: toTmdbLocale(language),
        };

        if (year && /^\d{4}$/.test(year)) {
          params[getSearchYearParam(mediaType)] = year;
        }

        const payload = await requestTmdbJson<TmdbSearchResponse>(
          `/search/${mediaType}`,
          params,
          { apiKey, fetchImpl, timeoutMs },
        );
        const results = Array.isArray(payload.results)
          ? payload.results
              .map((result) => normalizeSearchResult(mediaType, result))
              .filter(Boolean)
          : [];

        sendJson(response, 200, { results });
        return true;
      }

      if (url.pathname === `${basePath}/images`) {
        if (request.method !== "GET") {
          sendMethodNotAllowed(response, ["GET", "OPTIONS"]);
          return true;
        }

        const apiKey = requireTmdbApiKey();
        const mediaType = validateMediaType(url.searchParams.get("mediaType"));
        const tmdbId = validateTmdbId(url.searchParams.get("tmdbId"));
        const kind = validateArtworkKind(url.searchParams.get("kind"));
        const language = normalizePreferredLanguage(
          url.searchParams.get("language"),
        );
        const payload = await requestTmdbJson<TmdbImageResponse>(
          `/${mediaType}/${tmdbId}/images`,
          {
            language: toTmdbLocale(language),
            include_image_language: TMDB_INCLUDE_IMAGE_LANGUAGE,
          },
          { apiKey, fetchImpl, timeoutMs },
        );
        const images = normalizeImages(payload, kind, language);

        sendJson(response, 200, {
          images,
          languageFilter: ["en", "tr", null],
          targetFileName: getTargetFileName(kind),
        });
        return true;
      }

      if (url.pathname === `${basePath}/episode-metadata`) {
        if (request.method !== "GET") {
          sendMethodNotAllowed(response, ["GET", "OPTIONS"]);
          return true;
        }

        const apiKey = requireTmdbApiKey();
        const tmdbId = validateTmdbId(url.searchParams.get("tmdbId"));
        const seasonNumber = validateSeasonNumber(
          url.searchParams.get("seasonNumber"),
        );
        const thumbnailLanguage = validateEpisodeThumbnailLanguage(
          url.searchParams.get("thumbnailLanguage"),
        );
        const [englishPayload, turkishPayload] = await Promise.all([
          requestTmdbJson<TmdbSeasonDetailsResponse>(
            `/tv/${tmdbId}/season/${seasonNumber}`,
            { language: "en-US" },
            { apiKey, fetchImpl, timeoutMs },
          ),
          requestTmdbJson<TmdbSeasonDetailsResponse>(
            `/tv/${tmdbId}/season/${seasonNumber}`,
            { language: "tr-TR" },
            { apiKey, fetchImpl, timeoutMs },
          ),
        ]);
        const englishEpisodes = normalizeSeasonEpisodes(englishPayload);
        const turkishEpisodes = normalizeSeasonEpisodes(turkishPayload);
        const episodeNumbers = Array.from(
          new Set([...englishEpisodes.keys(), ...turkishEpisodes.keys()]),
        ).sort((left, right) => left - right);
        const stillEntries = await mapWithConcurrency(
          episodeNumbers,
          TMDB_EPISODE_STILL_CONCURRENCY,
          async (episodeNumber) =>
            [
              episodeNumber,
              await fetchEpisodeStill(
                tmdbId,
                seasonNumber,
                episodeNumber,
                thumbnailLanguage,
                { apiKey, fetchImpl, timeoutMs },
              ),
            ] as const,
        );
        const stillsByEpisode = new Map(stillEntries);
        const episodes = episodeNumbers.map((episodeNumber) => {
          const englishEpisode = englishEpisodes.get(episodeNumber);
          const turkishEpisode = turkishEpisodes.get(episodeNumber);
          const fallbackStillPath =
            englishEpisode?.stillPath ?? turkishEpisode?.stillPath ?? null;
          const fallbackStill = fallbackStillPath
            ? createEpisodeStill(fallbackStillPath, null)
            : null;

          return {
            seasonNumber,
            episodeNumber,
            name: {
              en: englishEpisode?.name ?? null,
              tr: turkishEpisode?.name ?? null,
            },
            overview: {
              en: englishEpisode?.overview ?? null,
              tr: turkishEpisode?.overview ?? null,
            },
            thumbnail: stillsByEpisode.get(episodeNumber) ?? fallbackStill,
          };
        });

        sendJson(response, 200, {
          seasonNumber,
          thumbnailLanguage,
          languageFilter: ["en", "tr", null],
          episodes,
        });
        return true;
      }

      if (url.pathname === `${basePath}/apply`) {
        if (request.method !== "POST") {
          sendMethodNotAllowed(response, ["POST", "OPTIONS"]);
          return true;
        }

        const jellyfinServerUrl = requireJellyfinServerUrl();
        const jellyfinApiKey = requireJellyfinApiKey();
        const body = await parseJsonBody<TmdbArtworkApplyBody>(request);
        const itemId = validateItemId(body.itemId);
        const kind = validateArtworkKind(body.kind);
        const filePath = validateTmdbFilePath(body.filePath);
        const item = await fetchJellyfinItem(itemId, {
          jellyfinServerUrl,
          apiKey: jellyfinApiKey,
          fetchImpl,
          timeoutMs,
        });
        const targetDirectory = await resolveArtworkTargetDirectory(
          item,
          options.mediaRoot,
        );
        const targetFileName = getTargetFileName(kind);
        const image = await downloadTmdbImage(filePath, kind, {
          fetchImpl,
          timeoutMs,
        });
        const targetPath = await writeSidecarArtwork(
          targetDirectory,
          targetFileName,
          image,
        );

        sendJson(response, 200, {
          itemId,
          kind,
          filePath,
          targetFileName,
          targetPath,
          bytes: image.byteLength,
        });
        return true;
      }

      sendJson(response, 404, {
        error: {
          code: "NOT_FOUND",
          message: "TMDB artwork route not found.",
        },
      });
      return true;
    } catch (error) {
      sendRouteError(response, error);
      return true;
    }
  };
}
