/**
 * The Newznab protocol: everything that knows what the XML looks like.
 *
 * Split from the HTTP client so the parsing can be tested against captured
 * responses without a socket, and so a provider quirk has one place to live.
 */
import {
  IndexerError,
  type IndexerCapabilities,
  type IndexerCategory,
  type IndexerRelease,
  type IndexerSearchMode,
  type IndexerSearchQuery,
  type IndexerSearchResult,
} from "./indexerTypes";
import {
  childNamed,
  childrenNamed,
  parseXml,
  XmlError,
  type XmlElement,
} from "./xmlReader";

/**
 * Newznab's own error codes, mapped to the reasons Seyirlik acts on.
 *
 * A provider reports these with HTTP 200, so a status check alone would treat
 * "incorrect credentials" as a successful empty search.
 */
export function classifyNewznabCode(code: string): IndexerError["kind"] {
  switch (code) {
    case "100": // incorrect credentials
    case "101": // account suspended
    case "102": // insufficient privileges
      return "auth";
    case "300": // no such item
      return "not-found";
    case "500": // request limit reached
      return "rate-limited";
    case "200": // missing parameter
    case "201": // incorrect parameter
    case "202": // no such function
    case "203": // function not available
      return "bad-request";
    default:
      return "provider-error";
  }
}

function requireRoot(body: string): XmlElement {
  try {
    return parseXml(body);
  } catch (error) {
    throw new IndexerError(
      "malformed-response",
      error instanceof XmlError
        ? `The provider sent XML this reader will not accept: ${error.message}`
        : "The provider sent a response that could not be read as XML.",
    );
  }
}

/** Throws if the document is Newznab's error envelope rather than a result. */
function throwIfErrorDocument(root: XmlElement): void {
  if (root.name !== "error") return;
  const code = root.attributes.get("code") ?? "";
  // The description is the provider's own words about the request, not a
  // response body, so it is safe to carry; the URL and key never are.
  const description =
    root.attributes.get("description") ?? "The provider refused the request.";
  throw new IndexerError(
    classifyNewznabCode(code),
    description,
    code || undefined,
  );
}

function toInteger(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function parseSearchMode(element: XmlElement | undefined): IndexerSearchMode {
  if (!element) return { available: false, supportedParams: [] };
  const available =
    (element.attributes.get("available") ?? "").toLowerCase() === "yes";
  const params = (element.attributes.get("supportedParams") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return { available, supportedParams: params };
}

function parseCategory(element: XmlElement): IndexerCategory {
  const id = toInteger(element.attributes.get("id"));
  return {
    id: id ?? -1,
    name: element.attributes.get("name") ?? "",
    subcategories: childrenNamed(element, "subcat").map(parseCategory),
  };
}

export function parseCapabilities(
  body: string,
  now: () => number = Date.now,
): IndexerCapabilities {
  const root = requireRoot(body);
  throwIfErrorDocument(root);
  if (root.name !== "caps") {
    throw new IndexerError(
      "malformed-response",
      "The provider did not answer with a capabilities document.",
    );
  }
  const limits = childNamed(root, "limits");
  const searching = childNamed(root, "searching");
  const categories = childNamed(root, "categories");
  const max = toInteger(limits?.attributes.get("max")) ?? 100;
  return {
    ...(childNamed(root, "server")?.attributes.get("title")
      ? { serverTitle: childNamed(root, "server")!.attributes.get("title")! }
      : {}),
    limits: {
      default:
        toInteger(limits?.attributes.get("default")) ?? Math.min(100, max),
      max,
    },
    modes: {
      search: parseSearchMode(
        searching ? childNamed(searching, "search") : undefined,
      ),
      movie: parseSearchMode(
        searching ? childNamed(searching, "movie-search") : undefined,
      ),
      tv: parseSearchMode(
        searching ? childNamed(searching, "tv-search") : undefined,
      ),
    },
    categories: categories
      ? childrenNamed(categories, "category").map(parseCategory)
      : [],
    retrievedAtMs: now(),
  };
}

/** Every `newznab:attr`, namespace prefix ignored so a variant still reads. */
function collectAttributes(item: XmlElement): Record<string, string> {
  const attributes: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const child of item.children) {
    if (!child.name.endsWith("attr")) continue;
    const name = child.attributes.get("name");
    const value = child.attributes.get("value");
    if (name && value !== undefined && !(name in attributes))
      attributes[name] = value;
  }
  return attributes;
}

function parseDate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface ParseSearchOptions {
  readonly indexerId: string;
  readonly indexerName: string;
  readonly protocol: "usenet" | "torrent";
  readonly offset: number;
  readonly limit: number;
}

export function parseSearchResults(
  body: string,
  options: ParseSearchOptions,
): IndexerSearchResult {
  const root = requireRoot(body);
  throwIfErrorDocument(root);
  if (root.name !== "rss") {
    throw new IndexerError(
      "malformed-response",
      "The provider did not answer with an RSS document.",
    );
  }
  const channel = childNamed(root, "channel");
  if (!channel) {
    throw new IndexerError(
      "malformed-response",
      "The provider's RSS document has no channel.",
    );
  }

  const response = channel.children.find((child) =>
    child.name.endsWith("response"),
  );
  const totalAvailable = toInteger(response?.attributes.get("total"));

  const releases: IndexerRelease[] = [];
  for (const item of childrenNamed(channel, "item")) {
    const attributes = collectAttributes(item);
    const title = childNamed(item, "title")?.text.trim() ?? "";
    const link = childNamed(item, "link")?.text.trim() ?? "";
    const guid =
      childNamed(item, "guid")?.text.trim() || attributes.guid || link;
    // A release with nothing to fetch and no identity is not a result.
    if (!title || !guid || !link) continue;

    const enclosure = childNamed(item, "enclosure");
    const sizeBytes =
      toInteger(enclosure?.attributes.get("length")) ??
      toInteger(attributes.size);
    // Read from the elements, not the collapsed attribute map: a release
    // carries one `category` attr per category and the map keeps only the first.
    const categoryIds: number[] = [];
    for (const child of item.children) {
      if (!child.name.endsWith("attr")) continue;
      if (child.attributes.get("name") !== "category") continue;
      const value = toInteger(child.attributes.get("value"));
      if (value !== undefined && !categoryIds.includes(value))
        categoryIds.push(value);
    }
    const detailsUrl = childNamed(item, "comments")?.text.trim();

    releases.push({
      indexerId: options.indexerId,
      indexerName: options.indexerName,
      protocol: options.protocol,
      guid,
      title,
      ...(detailsUrl ? { detailsUrl } : {}),
      downloadUrl: link,
      ...(parseDate(childNamed(item, "pubDate")?.text.trim()) === undefined
        ? {}
        : {
            publishedAtMs: parseDate(childNamed(item, "pubDate")!.text.trim())!,
          }),
      ...(sizeBytes === undefined ? {} : { sizeBytes }),
      categoryIds,
      ...(toInteger(attributes.grabs) === undefined
        ? {}
        : { grabs: toInteger(attributes.grabs)! }),
      ...(toInteger(attributes.seeders) === undefined
        ? {}
        : { seeders: toInteger(attributes.seeders)! }),
      ...(toInteger(attributes.peers) === undefined &&
      toInteger(attributes.leechers) === undefined
        ? {}
        : {
            leechers: (toInteger(attributes.leechers) ??
              toInteger(attributes.peers))!,
          }),
      attributes: { ...attributes },
    });
  }

  return {
    releases,
    ...(totalAvailable === undefined ? {} : { totalAvailable }),
    offset: options.offset,
    limit: options.limit,
  };
}

/**
 * The query string for a search, without the credential.
 *
 * The API key is added by the client at the moment of the request so that it
 * cannot end up in anything built, logged or asserted on here.
 */
export function buildSearchParams(
  query: IndexerSearchQuery,
  capabilities: IndexerCapabilities | undefined,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set(
    "t",
    query.kind === "movie"
      ? "movie"
      : query.kind === "tv"
        ? "tvsearch"
        : "search",
  );
  params.set("o", "xml");
  if (query.term) params.set("q", query.term);
  if (query.imdbId) params.set("imdbid", query.imdbId.replace(/^tt/i, ""));
  if (query.tvdbId) params.set("tvdbid", query.tvdbId);
  if (query.season !== undefined) params.set("season", String(query.season));
  if (query.episode !== undefined) params.set("ep", String(query.episode));
  if (query.categoryIds?.length) params.set("cat", query.categoryIds.join(","));
  // Clamped to what the provider said it allows rather than to a guess.
  const max = capabilities?.limits.max ?? 100;
  const limit = Math.min(
    query.limit ?? capabilities?.limits.default ?? 50,
    max,
  );
  params.set("limit", String(Math.max(1, limit)));
  if (query.offset) params.set("offset", String(query.offset));
  return params;
}
