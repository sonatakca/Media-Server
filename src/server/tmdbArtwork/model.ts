export type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

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

export interface JellyfinItemResponse {
  Id?: unknown;
  Name?: unknown;
  Type?: unknown;
  MediaType?: unknown;
  ExtraType?: unknown;
  Path?: unknown;
  MediaSources?: unknown;
  ProviderIds?: unknown;
  ParentId?: unknown;
  SeriesId?: unknown;
}

export interface JellyfinItemsResponse {
  Items?: unknown;
}

export interface JellyfinMediaSource {
  Protocol?: unknown;
  Path?: unknown;
}

export interface TmdbSearchResponse {
  results?: unknown;
}

export interface TmdbMovieSearchResult {
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

export interface TmdbTvSearchResult {
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

export interface TmdbImageResponse {
  backdrops?: unknown;
  logos?: unknown;
  posters?: unknown;
}

export interface TmdbSeasonDetailsResponse {
  episodes?: unknown;
}

export interface TmdbRawSeasonEpisode {
  episode_number?: unknown;
  name?: unknown;
  overview?: unknown;
  still_path?: unknown;
}

export interface TmdbEpisodeImageResponse {
  stills?: unknown;
}

export interface TmdbEpisodeTranslationsResponse {
  translations?: unknown;
}

export interface TmdbRawEpisodeTranslation {
  iso_3166_1?: unknown;
  iso_639_1?: unknown;
  data?: unknown;
}

export interface TmdbRawEpisodeTranslationData {
  name?: unknown;
  overview?: unknown;
}

export interface TmdbRawImage {
  aspect_ratio?: unknown;
  file_path?: unknown;
  height?: unknown;
  iso_639_1?: unknown;
  vote_average?: unknown;
  vote_count?: unknown;
  width?: unknown;
}

export interface TmdbArtworkApplyBody {
  itemId?: unknown;
  kind?: unknown;
  filePath?: unknown;
}

export interface JellyfinLookupOptions {
  jellyfinServerUrl: string;
  apiKey: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}

export interface NormalizedTmdbImage {
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

export interface NormalizedTmdbEpisodeStill {
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

export interface NormalizedTmdbSeasonEpisode {
  episodeNumber: number;
  name: string | null;
  overview: string | null;
  stillPath: string | null;
}

export interface NormalizedTmdbEpisodeTranslations {
  name: Record<"en" | "tr", string | null>;
  overview: Record<"en" | "tr", string | null>;
}

export type ErrorStatusCode =
  | 400
  | 403
  | 404
  | 405
  | 409
  | 413
  | 500
  | 502
  | 503;

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1024;
export const TMDB_API_BASE_URL = "https://api.themoviedb.org/3/";
export const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
export const TMDB_ALLOWED_IMAGE_LANGUAGES = new Set(["en", "tr"]);
export const TMDB_INCLUDE_IMAGE_LANGUAGE = "en,tr,null";
export const TMDB_EPISODE_STILL_CONCURRENCY = 6;
export const ITEM_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
export const TMDB_FILE_PATH_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
export const LOCAL_URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export const TARGET_FILE_BY_KIND: Record<TmdbArtworkKind, string> = {
  poster: "folder.jpg",
  backdrop: "backdrop.jpg",
  landscape: "landscape.jpg",
  logo: "logo.png",
};

export class TmdbArtworkRouteError extends Error {
  code: string;
  statusCode: ErrorStatusCode;

  constructor(code: string, message: string, statusCode: ErrorStatusCode) {
    super(message);
    this.name = "TmdbArtworkRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}
