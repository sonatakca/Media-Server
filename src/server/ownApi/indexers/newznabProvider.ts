/**
 * A configured Newznab provider: the HTTP half of the adapter.
 *
 * The credential is held here and added to each request at the moment it is
 * sent. It is never part of a URL that is built for logging, returned to a
 * caller, or carried in an error — the TMDB client makes the same choice for
 * the same reason, and a Newznab key always rides in the query string.
 */
import {
  IndexerError,
  isRetryable,
  type IndexerCapabilities,
  type IndexerProtocol,
  type IndexerProvider,
  type IndexerSearchQuery,
  type IndexerSearchResult,
} from "./indexerTypes";
import {
  buildSearchParams,
  parseCapabilities,
  parseSearchResults,
} from "./newznab";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Capabilities change about as often as a provider is reconfigured. */
export const DEFAULT_CAPABILITIES_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
/** A page of results is tens of kilobytes; a megabyte is already an anomaly. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface NewznabProviderOptions {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Usually `/api`; taken from configuration because providers differ. */
  readonly apiPath?: string;
  readonly apiKey: string;
  readonly protocol?: IndexerProtocol;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  readonly capabilitiesTtlMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

function classifyStatus(status: number): IndexerError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "unavailable";
  return "bad-request";
}

/**
 * Turns anything thrown by `fetch` into a classified error.
 *
 * Nothing from the original is carried through. A fetch failure stringifies to
 * a message containing the request URL, and that URL contains the key.
 */
function classifyTransportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  timedOut: boolean,
): IndexerError {
  if (error instanceof IndexerError) return error;
  /*
   * The caller's signal, never the internal one. The timeout aborts our own
   * controller, so asking that controller whether it was aborted answers yes
   * for a timeout as well — and the two must not be confused, because a
   * timeout is worth retrying and a cancellation is the caller saying stop.
   */
  if (callerSignal?.aborted)
    return new IndexerError("cancelled", "The search was cancelled.");
  if (timedOut || (error instanceof Error && error.name === "AbortError")) {
    return new IndexerError("timeout", "The provider did not answer in time.");
  }
  return new IndexerError("unavailable", "The provider could not be reached.");
}

export function createNewznabProvider(
  options: NewznabProviderOptions,
): IndexerProvider {
  const {
    id,
    name,
    apiKey,
    protocol = "usenet",
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    capabilitiesTtlMs = DEFAULT_CAPABILITIES_TTL_MS,
    fetchImpl = fetch,
    now = Date.now,
    sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  if (!apiKey.trim()) throw new Error("A Newznab provider needs an API key.");
  const endpoint = new URL(
    (options.apiPath ?? "/api").replace(/^\/*/, "/"),
    options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`,
  );

  let cached: IndexerCapabilities | undefined;
  let inFlightCapabilities: Promise<IndexerCapabilities> | undefined;

  async function requestOnce(
    params: URLSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const url = new URL(endpoint);
    for (const [key, value] of params) url.searchParams.set(key, value);
    url.searchParams.set("apikey", apiKey);

    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { Accept: "application/xml, text/xml;q=0.9, */*;q=0.1" },
      });
      if (!response.ok) {
        const retryAfter = response.headers?.get?.("retry-after") ?? undefined;
        throw new IndexerError(
          classifyStatus(response.status),
          `The provider answered ${response.status}.`,
          retryAfter ? `retry-after:${retryAfter}` : undefined,
        );
      }
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) {
        throw new IndexerError(
          "malformed-response",
          "The provider's response is implausibly large.",
        );
      }
      return body;
    } catch (error) {
      throw classifyTransportError(error, signal, timedOut);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Bounded: `maxAttempts` in total, and only for reasons that can pass. */
  async function request(
    params: URLSearchParams,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    let lastError: IndexerError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await requestOnce(params, signal);
      } catch (error) {
        const failure =
          error instanceof IndexerError
            ? error
            : classifyTransportError(error, signal, false);
        lastError = failure;
        if (!isRetryable(failure.kind) || attempt === maxAttempts)
          throw failure;
        if (signal?.aborted)
          throw new IndexerError("cancelled", "The search was cancelled.");
        await sleep(retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw (
      lastError ??
      new IndexerError("unavailable", "The provider could not be reached.")
    );
  }

  async function capabilities(
    signal?: AbortSignal,
  ): Promise<IndexerCapabilities> {
    if (cached && now() - cached.retrievedAtMs < capabilitiesTtlMs)
      return cached;
    // One flight at a time: a burst of searches on a cold cache must not
    // become a burst of caps requests against a rate-limited provider.
    inFlightCapabilities ??= (async () => {
      try {
        const body = await request(
          new URLSearchParams({ t: "caps", o: "xml" }),
          signal,
        );
        cached = parseCapabilities(body, now);
        return cached;
      } finally {
        inFlightCapabilities = undefined;
      }
    })();
    return inFlightCapabilities;
  }

  return {
    id,
    name,
    protocol,
    capabilities,
    async search(
      query: IndexerSearchQuery,
      signal?: AbortSignal,
    ): Promise<IndexerSearchResult> {
      // A failure to read capabilities must not stop a search: the limits are
      // an optimisation, and the provider will clamp what it disagrees with.
      const caps = await capabilities(signal).catch(() => undefined);
      const params = buildSearchParams(query, caps);
      const body = await request(params, signal);
      return parseSearchResults(body, {
        indexerId: id,
        indexerName: name,
        protocol,
        offset: query.offset ?? 0,
        limit: Number(params.get("limit") ?? 0),
      });
    },
  };
}
