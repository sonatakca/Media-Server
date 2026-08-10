import type { MatchCandidate } from "./matcher";

/**
 * TMDB v3 client.
 *
 * The API key lives only in this process — it is never sent to a browser, never
 * logged, and never appears in an error message. Failures are surfaced as a
 * small typed error so callers can distinguish "not found" from "provider is
 * down" without inspecting strings.
 */

export const TMDB_IMAGE_BASE_URL = "https://image.tmdb.org/t/p";
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
const REQUEST_TIMEOUT_MS = 10_000;

export type TmdbErrorKind = "not-found" | "rate-limited" | "unavailable";

export class TmdbError extends Error {
  constructor(
    readonly kind: TmdbErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

export interface TmdbPerson {
  name: string;
  role: "actor" | "director" | "writer" | "producer" | "composer";
  character?: string;
  order: number;
  providerId: string;
}

export interface TmdbTitleDetails {
  providerId: string;
  title: string;
  originalTitle?: string;
  overview?: string;
  tagline?: string;
  releaseDate?: string;
  endDate?: string;
  runtimeMs?: number;
  communityRating?: number;
  officialRating?: string;
  genres: string[];
  people: TmdbPerson[];
  posterPath?: string;
  backdropPaths: string[];
  logoPath?: string;
  imdbId?: string;
}

export interface TmdbEpisodeDetails {
  seasonNumber: number;
  episodeNumber: number;
  title?: string;
  overview?: string;
  airDate?: string;
  runtimeMs?: number;
  communityRating?: number;
  stillPath?: string;
}

export interface TmdbClient {
  searchMovies(title: string, year?: number): Promise<MatchCandidate[]>;
  searchSeries(title: string, year?: number): Promise<MatchCandidate[]>;
  getMovie(providerId: string): Promise<TmdbTitleDetails>;
  getSeries(providerId: string): Promise<TmdbTitleDetails>;
  getSeasonEpisodes(
    providerId: string,
    seasonNumber: number,
  ): Promise<TmdbEpisodeDetails[]>;
  /** Absolute artwork URL for a stored provider path. */
  buildImageUrl(imagePath: string, size: string): string;
}

interface TmdbSearchResponse {
  results?: Array<{
    id: number;
    title?: string;
    name?: string;
    original_title?: string;
    original_name?: string;
    release_date?: string;
    first_air_date?: string;
    popularity?: number;
  }>;
}

function yearFromDate(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) && year > 1800 ? year : undefined;
}

function minutesToMs(minutes: unknown): number | undefined {
  return typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
    ? Math.round(minutes * 60_000)
    : undefined;
}

export interface CreateTmdbClientOptions {
  apiKey: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

/**
 * TMDB has two credential formats and they authenticate differently:
 * a v4 read access token is a JWT sent as a bearer token, while a v3 key is a
 * 32-character hex string that must travel as the `api_key` query parameter.
 * Sending one as the other returns 401 on every request, so the format is
 * detected rather than assumed.
 */
export function isV4ReadAccessToken(apiKey: string): boolean {
  return apiKey.trim().startsWith("eyJ");
}

export function createTmdbClient({
  apiKey,
  language = "en-US",
  fetchImpl = fetch,
}: CreateTmdbClientOptions): TmdbClient {
  if (!apiKey.trim()) {
    throw new Error("SEYIRLIK_TMDB_API_KEY is required for metadata lookups.");
  }

  const usesBearerToken = isV4ReadAccessToken(apiKey);

  async function request<T>(
    endpoint: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(`${TMDB_API_BASE_URL}${endpoint}`);
    url.searchParams.set("language", language);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    if (!usesBearerToken) {
      url.searchParams.set("api_key", apiKey);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: {
          // A v4 token travels as a header so it cannot leak through a proxy
          // access log; a v3 key has no such option and rides in the query.
          ...(usesBearerToken ? { Authorization: `Bearer ${apiKey}` } : {}),
          Accept: "application/json",
        },
      });

      if (response.status === 404) {
        throw new TmdbError("not-found", "The provider has no such record.");
      }
      if (response.status === 429) {
        throw new TmdbError("rate-limited", "The provider is rate limiting.");
      }
      if (!response.ok) {
        throw new TmdbError("unavailable", "The provider request failed.");
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof TmdbError) throw error;
      // Deliberately does not include the URL: with a v3 key the query string
      // carries the credential.
      throw new TmdbError("unavailable", "The provider could not be reached.");
    } finally {
      clearTimeout(timeout);
    }
  }

  function toCandidates(
    response: TmdbSearchResponse,
    kind: "movie" | "tv",
  ): MatchCandidate[] {
    return (response.results ?? []).slice(0, 10).map((result) => {
      const title = (kind === "movie" ? result.title : result.name) ?? "";
      const originalTitle =
        kind === "movie" ? result.original_title : result.original_name;
      const year = yearFromDate(
        kind === "movie" ? result.release_date : result.first_air_date,
      );

      return {
        providerId: String(result.id),
        title,
        ...(originalTitle && originalTitle !== title ? { originalTitle } : {}),
        ...(year === undefined ? {} : { year }),
        ...(result.popularity === undefined
          ? {}
          : { popularity: result.popularity }),
      };
    });
  }

  function extractPeople(credits: unknown): TmdbPerson[] {
    const people: TmdbPerson[] = [];
    if (!credits || typeof credits !== "object") return people;

    const typed = credits as {
      cast?: Array<{ id: number; name: string; character?: string; order?: number }>;
      crew?: Array<{ id: number; name: string; job?: string }>;
    };

    // Cast is capped: a full crew list of hundreds of names is noise on a detail
    // page and a great deal of write amplification on every refresh.
    for (const [index, member] of (typed.cast ?? []).slice(0, 20).entries()) {
      people.push({
        providerId: String(member.id),
        name: member.name,
        role: "actor",
        ...(member.character ? { character: member.character } : {}),
        order: member.order ?? index,
      });
    }

    const crewRoles: Record<string, TmdbPerson["role"]> = {
      Director: "director",
      Writer: "writer",
      Screenplay: "writer",
      Producer: "producer",
      "Original Music Composer": "composer",
    };
    for (const member of typed.crew ?? []) {
      const role = member.job ? crewRoles[member.job] : undefined;
      if (!role) continue;
      people.push({
        providerId: String(member.id),
        name: member.name,
        role,
        order: 100,
      });
    }

    return people;
  }

  function extractLogoPath(images: unknown): string | undefined {
    if (!images || typeof images !== "object") return undefined;
    const logos = (images as { logos?: Array<{ file_path?: string }> }).logos;
    return logos?.[0]?.file_path;
  }

  function extractBackdropPaths(images: unknown, fallback?: string): string[] {
    const paths: string[] = [];
    if (images && typeof images === "object") {
      const backdrops = (images as { backdrops?: Array<{ file_path?: string }> })
        .backdrops;
      for (const backdrop of (backdrops ?? []).slice(0, 5)) {
        if (backdrop.file_path) paths.push(backdrop.file_path);
      }
    }
    if (paths.length === 0 && fallback) paths.push(fallback);
    return paths;
  }

  async function getTitle(
    kind: "movie" | "tv",
    providerId: string,
  ): Promise<TmdbTitleDetails> {
    const details = await request<Record<string, unknown>>(
      `/${kind}/${encodeURIComponent(providerId)}`,
      {
        append_to_response: "credits,images,release_dates,content_ratings",
        // Language-neutral artwork is included so a logo exists even when the
        // localized set is empty.
        include_image_language: `${language.slice(0, 2)},en,null`,
      },
    );

    const title =
      (kind === "movie" ? details.title : details.name) ?? "";
    const originalTitle =
      kind === "movie" ? details.original_title : details.original_name;
    const releaseDate =
      kind === "movie" ? details.release_date : details.first_air_date;

    const runtimeMs =
      kind === "movie"
        ? minutesToMs(details.runtime)
        : minutesToMs(
            Array.isArray(details.episode_run_time)
              ? (details.episode_run_time as number[])[0]
              : undefined,
          );

    return {
      providerId,
      title: String(title),
      ...(typeof originalTitle === "string" && originalTitle !== title
        ? { originalTitle }
        : {}),
      ...(typeof details.overview === "string" && details.overview
        ? { overview: details.overview }
        : {}),
      ...(typeof details.tagline === "string" && details.tagline
        ? { tagline: details.tagline }
        : {}),
      ...(typeof releaseDate === "string" && releaseDate
        ? { releaseDate }
        : {}),
      ...(typeof details.last_air_date === "string" && details.last_air_date
        ? { endDate: details.last_air_date }
        : {}),
      ...(runtimeMs === undefined ? {} : { runtimeMs }),
      ...(typeof details.vote_average === "number" && details.vote_average > 0
        ? { communityRating: details.vote_average }
        : {}),
      genres: Array.isArray(details.genres)
        ? (details.genres as Array<{ name?: string }>)
            .map((genre) => genre.name)
            .filter((name): name is string => typeof name === "string")
        : [],
      people: extractPeople(details.credits),
      ...(typeof details.poster_path === "string"
        ? { posterPath: details.poster_path }
        : {}),
      backdropPaths: extractBackdropPaths(
        details.images,
        typeof details.backdrop_path === "string"
          ? details.backdrop_path
          : undefined,
      ),
      ...(extractLogoPath(details.images)
        ? { logoPath: extractLogoPath(details.images) as string }
        : {}),
      ...(typeof details.imdb_id === "string" && details.imdb_id
        ? { imdbId: details.imdb_id }
        : {}),
    };
  }

  return {
    searchMovies: async (title, year) =>
      toCandidates(
        await request<TmdbSearchResponse>("/search/movie", {
          query: title,
          ...(year === undefined ? {} : { year: String(year) }),
        }),
        "movie",
      ),

    searchSeries: async (title, year) =>
      toCandidates(
        await request<TmdbSearchResponse>("/search/tv", {
          query: title,
          ...(year === undefined
            ? {}
            : { first_air_date_year: String(year) }),
        }),
        "tv",
      ),

    getMovie: (providerId) => getTitle("movie", providerId),
    getSeries: (providerId) => getTitle("tv", providerId),

    getSeasonEpisodes: async (providerId, seasonNumber) => {
      const season = await request<{
        episodes?: Array<{
          season_number?: number;
          episode_number?: number;
          name?: string;
          overview?: string;
          air_date?: string;
          runtime?: number;
          vote_average?: number;
          still_path?: string;
        }>;
      }>(`/tv/${encodeURIComponent(providerId)}/season/${seasonNumber}`);

      return (season.episodes ?? [])
        .filter(
          (episode) =>
            typeof episode.episode_number === "number" &&
            typeof episode.season_number === "number",
        )
        .map((episode) => ({
          seasonNumber: episode.season_number as number,
          episodeNumber: episode.episode_number as number,
          ...(episode.name ? { title: episode.name } : {}),
          ...(episode.overview ? { overview: episode.overview } : {}),
          ...(episode.air_date ? { airDate: episode.air_date } : {}),
          ...(minutesToMs(episode.runtime) === undefined
            ? {}
            : { runtimeMs: minutesToMs(episode.runtime) as number }),
          ...(typeof episode.vote_average === "number" && episode.vote_average > 0
            ? { communityRating: episode.vote_average }
            : {}),
          ...(episode.still_path ? { stillPath: episode.still_path } : {}),
        }));
    },

    buildImageUrl: (imagePath, size) =>
      `${TMDB_IMAGE_BASE_URL}/${size}${imagePath}`,
  };
}
