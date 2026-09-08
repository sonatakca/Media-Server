/**
 * Seyirlik's own vocabulary for indexer search.
 *
 * Newznab's XML does not travel past `newznab.ts`. Everything above this line
 * — the search service, the API, and the release scoring a later phase will
 * add — works from these types, so a second provider protocol becomes another
 * adapter rather than a second shape spread through the product.
 */

/** Why a provider request did not produce results. Exhaustive on purpose. */
export type IndexerErrorKind =
  | "auth"
  | "not-found"
  | "rate-limited"
  | "bad-request"
  | "provider-error"
  | "malformed-response"
  | "timeout"
  | "cancelled"
  | "unavailable";

export class IndexerError extends Error {
  readonly kind: IndexerErrorKind;
  /** The provider's own code, where it gave one. Never its response body. */
  readonly providerCode?: string;

  constructor(kind: IndexerErrorKind, message: string, providerCode?: string) {
    super(message);
    this.name = "IndexerError";
    this.kind = kind;
    if (providerCode !== undefined) this.providerCode = providerCode;
  }
}

/** Whether retrying the same request could plausibly succeed. */
export function isRetryable(kind: IndexerErrorKind): boolean {
  return (
    kind === "unavailable" || kind === "timeout" || kind === "rate-limited"
  );
}

export type IndexerProtocol = "usenet" | "torrent";

export interface IndexerCategory {
  readonly id: number;
  readonly name: string;
  readonly subcategories: readonly IndexerCategory[];
}

export interface IndexerSearchMode {
  readonly available: boolean;
  /** e.g. `q`, `imdbid`, `season`, `ep` — what the provider says it accepts. */
  readonly supportedParams: readonly string[];
}

export interface IndexerCapabilities {
  readonly serverTitle?: string;
  /** The provider's own paging limits; `search` never exceeds `max`. */
  readonly limits: { readonly default: number; readonly max: number };
  readonly modes: {
    readonly search: IndexerSearchMode;
    readonly movie: IndexerSearchMode;
    readonly tv: IndexerSearchMode;
  };
  readonly categories: readonly IndexerCategory[];
  readonly retrievedAtMs: number;
}

/**
 * One release as Seyirlik understands it.
 *
 * `title` is kept exactly as the provider wrote it. A later phase parses
 * resolution, source, codec and release group out of it; doing that here would
 * put release-selection policy inside the protocol layer, and a normalisation
 * that has already thrown information away cannot be improved later.
 */
export interface IndexerRelease {
  readonly indexerId: string;
  readonly indexerName: string;
  readonly protocol: IndexerProtocol;
  /** Stable for this provider; the deduplication key. */
  readonly guid: string;
  readonly title: string;
  readonly detailsUrl?: string;
  /**
   * The provider URL that yields the NZB.
   *
   * Carries the API key in its query string for every Newznab provider, so it
   * is deliberately absent from `IndexerReleaseDto` and must never be logged
   * or returned. Callers that need to fetch it do so inside the server.
   */
  readonly downloadUrl: string;
  readonly publishedAtMs?: number;
  readonly sizeBytes?: number;
  readonly categoryIds: readonly number[];
  readonly grabs?: number;
  /** Present only for torrent providers; Usenet leaves them undefined. */
  readonly seeders?: number;
  readonly leechers?: number;
  /**
   * Every `newznab:attr` the provider sent, unaltered.
   *
   * The contained extension area: it keeps provider-specific facts available
   * to a later phase without any of them becoming part of the shared model.
   */
  readonly attributes: Readonly<Record<string, string>>;
}

/** What a search asks for, independent of any provider. */
export interface IndexerSearchQuery {
  readonly kind: "search" | "movie" | "tv";
  readonly term?: string;
  readonly imdbId?: string;
  readonly tvdbId?: string;
  readonly season?: number;
  readonly episode?: number;
  readonly categoryIds?: readonly number[];
  readonly limit?: number;
  readonly offset?: number;
}

export interface IndexerSearchResult {
  readonly releases: readonly IndexerRelease[];
  /** Total the provider claims, when it says; not the length of this page. */
  readonly totalAvailable?: number;
  readonly offset: number;
  readonly limit: number;
}

/**
 * What every provider adapter offers. Small on purpose: these are the
 * operations NZBgeek justifies today, and the shape a second Newznab-family
 * provider would fill in unchanged.
 */
export interface IndexerProvider {
  readonly id: string;
  readonly name: string;
  readonly protocol: IndexerProtocol;
  capabilities(signal?: AbortSignal): Promise<IndexerCapabilities>;
  search(
    query: IndexerSearchQuery,
    signal?: AbortSignal,
  ): Promise<IndexerSearchResult>;
}

/** The wire shape. `downloadUrl` is absent by construction, not by omission. */
export interface IndexerReleaseDto {
  readonly indexerId: string;
  readonly indexerName: string;
  readonly protocol: IndexerProtocol;
  readonly guid: string;
  readonly title: string;
  readonly detailsUrl?: string;
  readonly publishedAt?: string;
  readonly sizeBytes?: number;
  readonly categoryIds: readonly number[];
  readonly grabs?: number;
  readonly seeders?: number;
  readonly leechers?: number;
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * Drops the credential-bearing URL on the way out.
 *
 * A release is only ever handed to a client through this function, so there is
 * one place to check rather than one per route.
 */
export function toReleaseDto(release: IndexerRelease): IndexerReleaseDto {
  return {
    indexerId: release.indexerId,
    indexerName: release.indexerName,
    protocol: release.protocol,
    guid: release.guid,
    title: release.title,
    ...(release.detailsUrl === undefined
      ? {}
      : { detailsUrl: release.detailsUrl }),
    ...(release.publishedAtMs === undefined
      ? {}
      : { publishedAt: new Date(release.publishedAtMs).toISOString() }),
    ...(release.sizeBytes === undefined
      ? {}
      : { sizeBytes: release.sizeBytes }),
    categoryIds: release.categoryIds,
    ...(release.grabs === undefined ? {} : { grabs: release.grabs }),
    ...(release.seeders === undefined ? {} : { seeders: release.seeders }),
    ...(release.leechers === undefined ? {} : { leechers: release.leechers }),
    attributes: release.attributes,
  };
}
