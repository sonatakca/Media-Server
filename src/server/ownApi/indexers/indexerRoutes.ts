/**
 * Seyirlik's own search surface.
 *
 * Discovery only. There is deliberately no endpoint here that fetches an NZB
 * or hands work to a download client: acquisition is a later phase, and an
 * endpoint that grabs is one that mutates somebody's library.
 */
import { OwnApiError } from "../ownApiHandler";
import { sendData } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  optionalBodyString,
  optionalBodyStringArray,
  validationError,
} from "../api/validation";
import {
  IndexerError,
  toReleaseDto,
  type IndexerSearchQuery,
} from "./indexerTypes";
import type { IndexerRegistry } from "./indexerRegistry";
import type { IndexerSearchService } from "./searchService";

const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_OFFSET = 10_000;
const MAX_TERM_LENGTH = 256;

/** Anything else in the body is a caller mistake, not a field to ignore. */
const SEARCH_BODY_KEYS = [
  "kind",
  "term",
  "imdbId",
  "tvdbId",
  "season",
  "episode",
  "categoryIds",
  "limit",
  "offset",
  "indexerIds",
] as const;

/** How a provider failure is reported to a caller. */
const STATUS_BY_KIND: Record<string, { status: number; code: string }> = {
  auth: { status: 502, code: "INDEXER_AUTH_FAILED" },
  "not-found": { status: 404, code: "INDEXER_NOT_FOUND" },
  "rate-limited": { status: 503, code: "INDEXER_RATE_LIMITED" },
  "bad-request": { status: 400, code: "INDEXER_REJECTED_REQUEST" },
  "provider-error": { status: 502, code: "INDEXER_ERROR" },
  "malformed-response": { status: 502, code: "INDEXER_MALFORMED_RESPONSE" },
  timeout: { status: 504, code: "INDEXER_TIMEOUT" },
  cancelled: { status: 499, code: "INDEXER_CANCELLED" },
  unavailable: { status: 503, code: "INDEXER_UNAVAILABLE" },
};

function asApiError(error: unknown): OwnApiError {
  if (!(error instanceof IndexerError)) {
    return new OwnApiError("INDEXER_UNAVAILABLE", "The indexer failed.", 503);
  }
  const mapped = STATUS_BY_KIND[error.kind] ?? {
    status: 503,
    code: "INDEXER_UNAVAILABLE",
  };
  // The provider's own sentence, which never contains the request or the key.
  return new OwnApiError(mapped.code, error.message, mapped.status);
}

function parseQuery(body: Record<string, unknown>): IndexerSearchQuery {
  const kind = optionalBodyString(body, "kind") ?? "search";
  if (kind !== "search" && kind !== "movie" && kind !== "tv") {
    throw validationError("The kind must be search, movie or tv.");
  }
  const term = optionalBodyString(body, "term");
  if (term !== undefined && term.length > MAX_TERM_LENGTH) {
    throw validationError("The term is too long.");
  }
  const imdbId = optionalBodyString(body, "imdbId");
  if (imdbId !== undefined && !/^(tt)?\d{6,10}$/i.test(imdbId)) {
    throw validationError("The imdbId is not an IMDb identifier.");
  }
  const tvdbId = optionalBodyString(body, "tvdbId");
  if (tvdbId !== undefined && !/^\d{1,10}$/.test(tvdbId)) {
    throw validationError("The tvdbId is not a TVDB identifier.");
  }
  const season = optionalBodyInteger(body, "season", { min: 0, max: 10_000 });
  const episode = optionalBodyInteger(body, "episode", { min: 0, max: 10_000 });
  const limit = optionalBodyInteger(body, "limit", {
    min: 1,
    max: MAX_SEARCH_LIMIT,
  });
  const offset = optionalBodyInteger(body, "offset", {
    min: 0,
    max: MAX_SEARCH_OFFSET,
  });

  const rawCategories = body.categoryIds;
  let categoryIds: number[] | undefined;
  if (rawCategories !== undefined) {
    if (!Array.isArray(rawCategories) || rawCategories.length > 50) {
      throw validationError("The categoryIds must be a short array of ids.");
    }
    categoryIds = rawCategories.map((value) => {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 1_000_000
      ) {
        throw validationError("Each category id must be a whole number.");
      }
      return value;
    });
  }

  if (!term && !imdbId && !tvdbId) {
    throw validationError("A search needs a term, an imdbId or a tvdbId.");
  }

  return {
    kind,
    ...(term ? { term } : {}),
    ...(imdbId ? { imdbId } : {}),
    ...(tvdbId ? { tvdbId } : {}),
    ...(season === undefined ? {} : { season }),
    ...(episode === undefined ? {} : { episode }),
    ...(categoryIds === undefined ? {} : { categoryIds }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  };
}

export interface CreateIndexerRoutesOptions {
  readonly registry: IndexerRegistry;
  readonly search: IndexerSearchService;
}

export function createIndexerRoutes({
  registry,
  search,
}: CreateIndexerRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/indexers",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          indexers: registry.list(),
        });
      },
    },
    {
      /**
       * What the provider says it can do, not what Seyirlik assumes. Category
       * ids differ between indexers, so hard-coding them would be a guess that
       * silently searches the wrong section.
       */
      method: "GET",
      path: "/indexers/:indexerId/capabilities",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = context.params.indexerId ?? "";
        if (!registry.get(id)) {
          throw new OwnApiError(
            "INDEXER_NOT_FOUND",
            "No such indexer is configured.",
            404,
          );
        }
        try {
          sendData(
            context.response,
            context.requestId,
            await registry.capabilities(id),
          );
        } catch (error) {
          throw asApiError(error);
        }
      },
    },
    {
      method: "POST",
      path: "/indexers/search",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), SEARCH_BODY_KEYS);
        const query = parseQuery(body);
        const indexerIds = optionalBodyStringArray(body, "indexerIds");

        // The request's own lifetime bounds the search: a caller that hangs up
        // should not leave provider requests running behind it.
        const controller = new AbortController();
        const abort = () => controller.abort();
        context.request.once("aborted", abort);
        context.request.once("close", abort);
        try {
          const result = await search.search(query, {
            ...(indexerIds?.length ? { indexerIds } : {}),
            signal: controller.signal,
          });
          sendData(context.response, context.requestId, {
            // `toReleaseDto` is the only way a release leaves the server, and
            // it has no field for the credential-bearing download URL.
            releases: result.releases.map(toReleaseDto),
            indexers: result.outcomes,
            partial: result.partial,
          });
        } catch (error) {
          throw asApiError(error);
        } finally {
          context.request.off("aborted", abort);
          context.request.off("close", abort);
        }
      },
    },
  ];
}
