import { constants } from "node:fs";
import {
  access,
  readFile,
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
import {
  DEFAULT_MAX_JSON_BODY_BYTES,
  DEFAULT_TIMEOUT_MS,
  ITEM_ID_PATTERN,
  LOGO_TARGET_FILE_BY_LANGUAGE,
  LOCAL_URL_PATTERN,
  MAX_IMAGE_BYTES,
  TARGET_FILE_BY_KIND,
  TMDB_ALLOWED_IMAGE_LANGUAGES,
  TMDB_API_BASE_URL,
  TMDB_EPISODE_STILL_CONCURRENCY,
  TMDB_FILE_PATH_PATTERN,
  TMDB_IMAGE_BASE_URL,
  TMDB_INCLUDE_IMAGE_LANGUAGE,
  TmdbArtworkRouteError,
  type FetchLike,
  type JellyfinItemResponse,
  type MediaItemsResponse,
  type JellyfinLookupOptions,
  type MediaSource,
  type NormalizedTmdbEpisodeStill,
  type NormalizedTmdbEpisodeTranslations,
  type NormalizedTmdbImage,
  type NormalizedTmdbSeasonEpisode,
  type TmdbArtworkApplyBody,
  type TmdbArtworkKind,
  type TmdbArtworkRequestHandlerOptions,
  type TmdbEpisodeImageResponse,
  type TmdbEpisodeTranslationsResponse,
  type TmdbImageLanguage,
  type TmdbImageResponse,
  type TmdbMediaType,
  type TmdbMovieSearchResult,
  type TmdbRawEpisodeTranslation,
  type TmdbRawEpisodeTranslationData,
  type TmdbRawImage,
  type TmdbRawSeasonEpisode,
  type TmdbSearchResponse,
  type TmdbSeasonDetailsResponse,
  type TmdbTvSearchResult,
} from "./tmdbArtwork/model";

export type {
  TmdbArtworkKind,
  TmdbArtworkRequestHandlerOptions,
  TmdbImageLanguage,
  TmdbMediaType,
} from "./tmdbArtwork/model";

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

function validateLogoLanguage(value: unknown): "en" | "tr" {
  if (value === undefined || value === null || value === "" || value === "en") {
    return "en";
  }

  if (value === "tr") {
    return "tr";
  }

  throw new TmdbArtworkRouteError(
    "TMDB_LOGO_LANGUAGE_INVALID",
    "Logo language must be English or Turkish.",
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

function getTargetFileName(
  kind: TmdbArtworkKind,
  logoLanguage: "en" | "tr" = "en",
): string {
  return kind === "logo"
    ? LOGO_TARGET_FILE_BY_LANGUAGE[logoLanguage]
    : TARGET_FILE_BY_KIND[kind];
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
  options: JellyfinLookupOptions,
): Promise<JellyfinItemResponse> {
  const requestUrl = new URL(
    "Items",
    `${normalizeJellyfinServerUrl(options.jellyfinServerUrl)}/`,
  );

  requestUrl.searchParams.set("Ids", itemId);
  requestUrl.searchParams.set(
    "Fields",
    "Path,MediaSources,ProviderIds,ParentId,SeriesId,ExtraType",
  );
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

  const payload = (await response.json()) as MediaItemsResponse;

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

async function fetchJellyfinItemByTmdbId(
  tmdbId: number,
  mediaType: TmdbMediaType,
  options: JellyfinLookupOptions,
): Promise<JellyfinItemResponse | null> {
  const requestUrl = new URL(
    "Items",
    `${normalizeJellyfinServerUrl(options.jellyfinServerUrl)}/`,
  );

  requestUrl.searchParams.set(
    "Fields",
    "Path,MediaSources,ProviderIds,ParentId,SeriesId,ExtraType",
  );
  requestUrl.searchParams.set(
    "IncludeItemTypes",
    mediaType === "movie" ? "Movie" : "Series",
  );
  requestUrl.searchParams.set("Recursive", "true");
  requestUrl.searchParams.set("HasTmdbId", "true");
  requestUrl.searchParams.set("EnableTotalRecordCount", "false");
  requestUrl.searchParams.set("Limit", "10000");

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
      "Jellyfin TMDB provider lookup failed.",
      502,
    );
  }

  const payload = (await response.json()) as MediaItemsResponse;
  const targetTmdbId = String(tmdbId);

  if (!Array.isArray(payload.Items)) {
    return null;
  }

  return (
    (payload.Items.find((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }

      const providerIds = (item as JellyfinItemResponse).ProviderIds;

      if (
        !providerIds ||
        typeof providerIds !== "object" ||
        Array.isArray(providerIds)
      ) {
        return false;
      }

      return Object.entries(providerIds).some(
        ([provider, value]) =>
          provider.toLocaleLowerCase("en-US") === "tmdb" &&
          String(value) === targetTmdbId,
      );
    }) as JellyfinItemResponse | undefined) ?? null
  );
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

function normalizeLocalizedMetadata(
  tmdbId: number,
  mediaType: TmdbMediaType,
  language: "en" | "tr",
  value: unknown,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const item = value as Record<string, unknown>;
  const rawGenres = Array.isArray(item.genres) ? item.genres : [];
  const genres = rawGenres.flatMap((genre) => {
    if (!genre || typeof genre !== "object" || Array.isArray(genre)) {
      return [];
    }

    const name = getString((genre as Record<string, unknown>).name);
    return name ? [name] : [];
  });

  return {
    tmdbId,
    mediaType,
    language,
    title: getString(mediaType === "movie" ? item.title : item.name),
    overview: getString(item.overview),
    genres,
  };
}

function compareImages(
  kind: TmdbArtworkKind,
  left: NormalizedTmdbImage,
  right: NormalizedTmdbImage,
): number {
  const languageRank = (image: NormalizedTmdbImage) => {
    if (kind === "logo") {
      if (image.language === "en") return 0;
      if (image.language === "tr") return 1;
      return 2;
    }

    if (image.language === null) return 0;
    if (image.language === "en") return 1;
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
      origin: "tmdb",
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
    compareImages(kind, left, right),
  );
}

function getPngDimensions(
  contents: Buffer,
): { width: number; height: number } | null {
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  if (
    contents.byteLength < 24 ||
    !contents.subarray(0, pngSignature.byteLength).equals(pngSignature) ||
    contents.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return null;
  }

  const width = contents.readUInt32BE(16);
  const height = contents.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

async function loadLocalLogoImagesFromDirectory(
  directoryPath: string,
): Promise<NormalizedTmdbImage[]> {
  const realDirectory = await realpath(directoryPath);
  const candidates = (["en", "tr"] as const).map((language) => ({
    language,
    fileName: LOGO_TARGET_FILE_BY_LANGUAGE[language],
  }));
  const images: NormalizedTmdbImage[] = [];

  for (const candidate of candidates) {
    const candidatePath = path.resolve(realDirectory, candidate.fileName);
    let realCandidate: string;

    try {
      realCandidate = await realpath(candidatePath);
    } catch {
      continue;
    }

    if (!isPathInsideOrEqualRoot(realDirectory, realCandidate)) {
      continue;
    }

    const candidateStat = await stat(realCandidate);

    if (
      !candidateStat.isFile() ||
      candidateStat.size <= 0 ||
      candidateStat.size > MAX_IMAGE_BYTES
    ) {
      continue;
    }

    const contents = await readFile(realCandidate);
    const dimensions = getPngDimensions(contents);

    const dataUrl = `data:image/png;base64,${contents.toString("base64")}`;
    images.push({
      id: `local-logo:${candidate.language}`,
      kind: "logo",
      sourceType: "logo",
      origin: "local",
      filePath: candidate.fileName,
      previewUrl: dataUrl,
      fullUrl: dataUrl,
      language: candidate.language,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      aspectRatio:
        dimensions && dimensions.height > 0
          ? dimensions.width / dimensions.height
          : null,
      voteAverage: null,
      voteCount: null,
      targetFileName: candidate.fileName,
    });
  }

  return images;
}

async function loadLocalLogoImages(
  directoryPath: string,
  mediaRoot: string,
): Promise<NormalizedTmdbImage[]> {
  const realMediaRoot = await realpath(mediaRoot);
  let currentDirectory = await realpath(directoryPath);

  while (isPathInsideOrEqualRoot(realMediaRoot, currentDirectory)) {
    const images = await loadLocalLogoImagesFromDirectory(currentDirectory);

    if (images.length > 0) {
      return images;
    }

    const parentDirectory = path.dirname(currentDirectory);

    if (
      parentDirectory === currentDirectory ||
      !isPathInsideOrEqualRoot(realMediaRoot, parentDirectory)
    ) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return [];
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

function createEmptyEpisodeTranslations(): NormalizedTmdbEpisodeTranslations {
  return {
    name: {
      en: null,
      tr: null,
    },
    overview: {
      en: null,
      tr: null,
    },
  };
}

function getTranslationRank(language: "en" | "tr", country: string | null) {
  const normalizedCountry = country?.toLocaleUpperCase("en-US") ?? "";

  if (language === "en" && normalizedCountry === "US") {
    return 0;
  }

  if (language === "tr" && normalizedCountry === "TR") {
    return 0;
  }

  return 1;
}

function normalizeEpisodeTranslations(
  response: TmdbEpisodeTranslationsResponse,
): NormalizedTmdbEpisodeTranslations {
  const translations = createEmptyEpisodeTranslations();
  const ranks: Record<"en" | "tr", number> = {
    en: Number.POSITIVE_INFINITY,
    tr: Number.POSITIVE_INFINITY,
  };

  if (!Array.isArray(response.translations)) {
    return translations;
  }

  for (const rawTranslation of response.translations) {
    if (
      !rawTranslation ||
      typeof rawTranslation !== "object" ||
      Array.isArray(rawTranslation)
    ) {
      continue;
    }

    const translation = rawTranslation as TmdbRawEpisodeTranslation;
    const language = getString(translation.iso_639_1)?.toLocaleLowerCase(
      "en-US",
    );

    if (language !== "en" && language !== "tr") {
      continue;
    }

    if (
      !translation.data ||
      typeof translation.data !== "object" ||
      Array.isArray(translation.data)
    ) {
      continue;
    }

    const rank = getTranslationRank(
      language,
      getString(translation.iso_3166_1),
    );

    if (rank > ranks[language]) {
      continue;
    }

    const data = translation.data as TmdbRawEpisodeTranslationData;
    const name = getString(data.name);
    const overview = getString(data.overview);

    if (!name && !overview) {
      continue;
    }

    translations.name[language] = name;
    translations.overview[language] = overview;
    ranks[language] = rank;
  }

  return translations;
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

async function fetchEpisodeTranslations(
  seriesId: number,
  seasonNumber: number,
  episodeNumber: number,
  options: {
    apiKey: string;
    fetchImpl: FetchLike;
    timeoutMs: number;
  },
): Promise<NormalizedTmdbEpisodeTranslations> {
  try {
    const payload = await requestTmdbJson<TmdbEpisodeTranslationsResponse>(
      `/tv/${seriesId}/season/${seasonNumber}/episode/${episodeNumber}/translations`,
      {},
      options,
    );

    return normalizeEpisodeTranslations(payload);
  } catch {
    return createEmptyEpisodeTranslations();
  }
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
        include_image_language:
          getEpisodeImageLanguageFilter(thumbnailLanguage),
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

function getPathSegments(pathValue: string): string[] {
  return pathValue.split(/[\\/]+/).filter(Boolean);
}

function getTrailersSegmentIndex(pathValue: string): number {
  return getPathSegments(pathValue).findIndex(
    (segment) => segment.toLocaleLowerCase("en-US") === "trailers",
  );
}

function getTrailerOwnerPath(candidatePath: string): string | null {
  const normalizedPath = candidatePath.replace(/\\/g, "/");
  const segments = normalizedPath.split("/");
  const trailersIndex = segments.findIndex(
    (segment) => segment.toLocaleLowerCase("en-US") === "trailers",
  );

  if (trailersIndex <= 0) {
    return null;
  }

  const ownerPath = segments.slice(0, trailersIndex).join("/");
  return ownerPath || null;
}

function isLocalFilesystemPath(candidatePath: string): boolean {
  return (
    !LOCAL_URL_PATTERN.test(candidatePath) &&
    (path.isAbsolute(candidatePath) ||
      path.win32.isAbsolute(candidatePath) ||
      path.posix.isAbsolute(candidatePath))
  );
}

function getItemPathCandidates(item: JellyfinItemResponse): string[] {
  return [getPathValue(item.Path), ...getFileMediaSourcePaths(item)].filter(
    (candidate): candidate is string => Boolean(candidate),
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

    const mediaSource = source as MediaSource;
    const protocol =
      typeof mediaSource.Protocol === "string"
        ? mediaSource.Protocol.toLowerCase()
        : "";
    const sourcePath = getPathValue(mediaSource.Path);

    return protocol === "file" && sourcePath ? [sourcePath] : [];
  });
}

function isJellyfinExtraItem(item: JellyfinItemResponse): boolean {
  if (getString(item.ExtraType)) {
    return true;
  }

  return getItemPathCandidates(item).some(
    (candidate) => getTrailersSegmentIndex(candidate) >= 0,
  );
}

function isUsableMetadataOwner(
  item: JellyfinItemResponse,
  childItem: JellyfinItemResponse,
): boolean {
  const itemId = getString(item.Id);
  const childItemId = getString(childItem.Id);
  const itemType = getString(item.Type);

  return (
    Boolean(itemId && itemId !== childItemId) &&
    !isJellyfinExtraItem(item) &&
    (itemType === "Movie" || itemType === "Series")
  );
}

async function resolveOwnerItemFromRelationships(
  item: JellyfinItemResponse,
  options: JellyfinLookupOptions,
): Promise<JellyfinItemResponse | null> {
  const candidateIds = Array.from(
    new Set(
      [getString(item.ParentId), getString(item.SeriesId)].filter(Boolean),
    ),
  ) as string[];

  for (const candidateId of candidateIds) {
    try {
      const candidate = await fetchJellyfinItem(candidateId, options);

      if (isUsableMetadataOwner(candidate, item)) {
        return candidate;
      }
    } catch {
      // Keep the filesystem fallback available for servers that omit or return
      // unusable extra relationships.
    }
  }

  return null;
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

async function resolveTrustedTrailerOwnerDirectory(
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

  const ownerPath = getTrailerOwnerPath(realCandidate);

  if (!ownerPath) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_EXTRA_OWNER_NOT_FOUND",
      "Could not resolve the owning media folder for this Jellyfin extra.",
      409,
    );
  }

  const realOwnerPath = await realpath(ownerPath);

  if (!isPathInsideOrEqualRoot(realMediaRoot, realOwnerPath)) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_LOCAL_PATH_REJECTED",
      "Jellyfin extra owner path is outside the configured media root.",
      403,
    );
  }

  const ownerStat = await stat(realOwnerPath);

  if (!ownerStat.isDirectory()) {
    throw new TmdbArtworkRouteError(
      "JELLYFIN_EXTRA_OWNER_NOT_FOUND",
      "Jellyfin extra owner path is not a directory.",
      409,
    );
  }

  await access(realOwnerPath, constants.R_OK | constants.W_OK);
  return realOwnerPath;
}

async function resolveArtworkTargetDirectory(
  item: JellyfinItemResponse,
  mediaRoot: string,
  lookupOptions: JellyfinLookupOptions,
): Promise<string> {
  const realMediaRoot = await assertMediaRootDirectory(mediaRoot);
  const isExtra = isJellyfinExtraItem(item);
  const ownerItem = isExtra
    ? await resolveOwnerItemFromRelationships(item, lookupOptions)
    : null;
  const candidates = getItemPathCandidates(ownerItem ?? item);
  let lastError: unknown;

  if (ownerItem || !isExtra) {
    for (const candidate of candidates) {
      try {
        return await resolveTrustedArtworkDirectory(realMediaRoot, candidate);
      } catch (error) {
        lastError = error;
      }
    }
  } else {
    for (const candidate of candidates) {
      try {
        return await resolveTrustedTrailerOwnerDirectory(
          realMediaRoot,
          candidate,
        );
      } catch (error) {
        lastError = error;
      }
    }
  }

  if (lastError instanceof TmdbArtworkRouteError) {
    throw lastError;
  }

  throw new TmdbArtworkRouteError(
    isExtra ? "JELLYFIN_EXTRA_OWNER_NOT_FOUND" : "JELLYFIN_LOCAL_PATH_MISSING",
    isExtra
      ? "Could not resolve the owning media folder for this Jellyfin extra."
      : "Jellyfin item does not expose a local file or folder path.",
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
        const tmdbImages = normalizeImages(payload, kind);
        let localImages: NormalizedTmdbImage[] = [];
        let localLogoStatus: "found" | "not-found" | "unavailable" | undefined;

        if (kind === "logo") {
          const rawItemId = url.searchParams.get("itemId");
          const requestedItemId = rawItemId ? validateItemId(rawItemId) : null;

          try {
            const jellyfinServerUrl = requireJellyfinServerUrl();
            const jellyfinApiKey = requireJellyfinApiKey();
            const lookupOptions = {
              jellyfinServerUrl,
              apiKey: jellyfinApiKey,
              fetchImpl,
              timeoutMs,
            };
            const checkedItemIds = new Set<string>();

            const checkItem = async (item: JellyfinItemResponse | null) => {
              if (!item) {
                return;
              }

              const resolvedItemId = getString(item.Id);

              if (resolvedItemId && checkedItemIds.has(resolvedItemId)) {
                return;
              }

              if (resolvedItemId) {
                checkedItemIds.add(resolvedItemId);
              }

              const targetDirectory = await resolveArtworkTargetDirectory(
                item,
                options.mediaRoot,
                lookupOptions,
              );
              localImages = await loadLocalLogoImages(
                targetDirectory,
                options.mediaRoot,
              );
            };

            if (requestedItemId) {
              await checkItem(
                await fetchJellyfinItem(requestedItemId, lookupOptions),
              );
            }

            if (localImages.length === 0) {
              await checkItem(
                await fetchJellyfinItemByTmdbId(
                  tmdbId,
                  mediaType,
                  lookupOptions,
                ),
              );
            }

            localLogoStatus = localImages.length > 0 ? "found" : "not-found";
          } catch {
            localLogoStatus = "unavailable";
          }
        }
        const images = [...localImages, ...tmdbImages];

        sendJson(response, 200, {
          images,
          languageFilter: ["en", "tr", null],
          targetFileName: getTargetFileName(kind),
          ...(localLogoStatus ? { localLogoStatus } : {}),
        });
        return true;
      }

      if (url.pathname === `${basePath}/metadata`) {
        if (request.method !== "GET") {
          sendMethodNotAllowed(response, ["GET", "OPTIONS"]);
          return true;
        }

        const apiKey = requireTmdbApiKey();
        const mediaType = validateMediaType(url.searchParams.get("mediaType"));
        const tmdbId = validateTmdbId(url.searchParams.get("tmdbId"));
        const language = normalizePreferredLanguage(
          url.searchParams.get("language"),
        );
        const payload = await requestTmdbJson<Record<string, unknown>>(
          `/${mediaType}/${tmdbId}`,
          { language: toTmdbLocale(language) },
          { apiKey, fetchImpl, timeoutMs },
        );

        sendJson(response, 200, {
          metadata: normalizeLocalizedMetadata(
            tmdbId,
            mediaType,
            language,
            payload,
          ),
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
        const episodeMetadataEntries = await mapWithConcurrency(
          episodeNumbers,
          TMDB_EPISODE_STILL_CONCURRENCY,
          async (episodeNumber) => {
            const [translations, still] = await Promise.all([
              fetchEpisodeTranslations(tmdbId, seasonNumber, episodeNumber, {
                apiKey,
                fetchImpl,
                timeoutMs,
              }),
              fetchEpisodeStill(
                tmdbId,
                seasonNumber,
                episodeNumber,
                thumbnailLanguage,
                { apiKey, fetchImpl, timeoutMs },
              ),
            ]);

            return [
              episodeNumber,
              {
                translations,
                still,
              },
            ] as const;
          },
        );
        const episodeMetadataByEpisode = new Map(episodeMetadataEntries);
        const episodes = episodeNumbers.map((episodeNumber) => {
          const episodeMetadata = episodeMetadataByEpisode.get(episodeNumber);
          const translations =
            episodeMetadata?.translations ?? createEmptyEpisodeTranslations();
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
            name: translations.name,
            overview: translations.overview,
            thumbnail: episodeMetadata?.still ?? fallbackStill,
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
        const logoLanguage =
          kind === "logo" ? validateLogoLanguage(body.language) : "en";
        const item = await fetchJellyfinItem(itemId, {
          jellyfinServerUrl,
          apiKey: jellyfinApiKey,
          fetchImpl,
          timeoutMs,
        });
        const targetDirectory = await resolveArtworkTargetDirectory(
          item,
          options.mediaRoot,
          {
            jellyfinServerUrl,
            apiKey: jellyfinApiKey,
            fetchImpl,
            timeoutMs,
          },
        );
        const targetFileName = getTargetFileName(kind, logoLanguage);
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
