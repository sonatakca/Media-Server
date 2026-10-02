/**
 * Search, and say what would be chosen.
 *
 * The join between Phase 2's discovery and Phase 3's judgement. It still stops
 * short of acquiring anything: there is no route here that fetches an NZB or
 * hands one to a download client, and the decision it returns names a winner
 * without doing anything about it.
 */
import { OwnApiError } from "../ownApiHandler";
import { sendData, sendNoContent } from "../api/envelope";
import type { RouteDefinition } from "../api/router";
import {
  asObjectBody,
  optionalBodyInteger,
  optionalBodyString,
  optionalBodyStringArray,
  requireBodyString,
  requireUuid,
  validationError,
} from "../api/validation";
import {
  IndexerError,
  type IndexerSearchQuery,
} from "../indexers/indexerTypes";
import type { IndexerSearchService } from "../indexers/searchService";
import {
  selectRelease,
  type CandidateDecision,
  type MediaTarget,
} from "./decide";
import { parseQualityId } from "./quality";
import { qualityLabel } from "./quality";
import type { PolicyRepository } from "./policyRepository";
import type { BlocklistRepository } from "./blocklistRepository";

/** Above this a limit is a typo, not a policy: no release is a terabyte. */
const MAX_SIZE_LIMIT_BYTES = 1_000_000_000_000;

const BODY_KEYS = [
  "kind",
  "title",
  "year",
  "season",
  "episode",
  "profileId",
  "indexerIds",
  "limit",
  "currentQualityId",
  "currentFormatScore",
] as const;

/**
 * What a decision looks like on the wire.
 *
 * Built from the release DTO rather than the release, so the credential-bearing
 * download URL has no path to a client here either — the same single
 * conversion that Phase 2 established, reused rather than re-implemented.
 */
interface DecisionDto {
  readonly guid: string;
  readonly indexerId: string;
  readonly title: string;
  readonly quality: string;
  readonly accepted: boolean;
  readonly rank: number | null;
  readonly score: number;
  readonly rejection?: string;
  readonly reasons: ReadonlyArray<{ code: string; detail: string }>;
  readonly sizeBytes?: number;
  readonly publishedAt?: string;
}

function toDecisionDto(decision: CandidateDecision): DecisionDto {
  return {
    guid: decision.release.guid,
    indexerId: decision.release.indexerId,
    title: decision.release.title,
    quality: qualityLabel(decision.quality),
    accepted: decision.accepted,
    rank: decision.rank,
    score: decision.score,
    ...(decision.rejection === undefined
      ? {}
      : { rejection: decision.rejection }),
    reasons: decision.reasons.map((reason) => ({
      code: reason.code,
      detail: reason.detail,
    })),
    ...(decision.release.sizeBytes === undefined
      ? {}
      : { sizeBytes: decision.release.sizeBytes }),
    ...(decision.release.publishedAtMs === undefined
      ? {}
      : {
          publishedAt: new Date(decision.release.publishedAtMs).toISOString(),
        }),
  };
}

function parseTarget(body: Record<string, unknown>): MediaTarget {
  const kind = optionalBodyString(body, "kind") ?? "movie";
  const title = requireBodyString(body, "title", { maxLength: 300 }).trim();
  if (!title) throw validationError("A title is required.");

  if (kind === "movie") {
    const year = optionalBodyInteger(body, "year", { min: 1870, max: 2200 });
    return { kind: "movie", title, ...(year === undefined ? {} : { year }) };
  }
  const season = optionalBodyInteger(body, "season", { min: 0, max: 10_000 });
  if (season === undefined) {
    throw validationError("A television target needs a season.");
  }
  if (kind === "season") return { kind: "season", title, season };
  if (kind === "episode") {
    const episode = optionalBodyInteger(body, "episode", {
      min: 0,
      max: 10_000,
    });
    if (episode === undefined) {
      throw validationError("An episode target needs an episode number.");
    }
    return { kind: "episode", title, season, episode };
  }
  throw validationError("The kind must be movie, season or episode.");
}

/** The search that would find candidates for this target. */
export function searchFor(
  target: MediaTarget,
  limit: number | undefined,
): IndexerSearchQuery {
  const base = {
    term: target.title,
    ...(limit === undefined ? {} : { limit }),
  };
  if (target.kind === "movie") return { kind: "movie", ...base };
  if (target.kind === "season") {
    return { kind: "tv", ...base, season: target.season };
  }
  return {
    kind: "tv",
    ...base,
    season: target.season,
    episode: target.episode,
  };
}

export interface CreateReleaseRoutesOptions {
  readonly search: IndexerSearchService;
  readonly policies: PolicyRepository;
  readonly blocklist: BlocklistRepository;
}

export function createReleaseRoutes({
  search,
  policies,
  blocklist,
}: CreateReleaseRoutesOptions): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/releases/profiles",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        sendData(context.response, context.requestId, {
          profiles: await policies.listProfiles(),
        });
      },
    },
    {
      /**
       * The largest release a profile accepts.
       *
       * The one part of a profile editable here, because it is the one part
       * that is a plain number: the qualities and preferences were migrated
       * and are edited where they came from.
       */
      method: "PATCH",
      path: "/releases/profiles/:profileId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const profileId = requireUuid(context.params.profileId, "profileId");
        const body = asObjectBody(await context.readJson(), ["maxSizeBytes"]);
        const raw = body.maxSizeBytes;
        if (
          raw !== null &&
          (!Number.isInteger(raw) ||
            (raw as number) < 1 ||
            (raw as number) > MAX_SIZE_LIMIT_BYTES)
        ) {
          throw validationError("maxSizeBytes is invalid.");
        }
        const maxSizeBytes = raw as number | null;
        if (!(await policies.setMaxSize(profileId, maxSizeBytes))) {
          throw new OwnApiError(
            "PROFILE_NOT_FOUND",
            "No such quality profile.",
            404,
          );
        }
        sendData(context.response, context.requestId, {
          profile: { id: profileId, maxSizeBytes },
        });
      },
    },
    {
      method: "GET",
      path: "/releases/blocklist",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        // The guid is left out: some indexers put a download URL in it.
        sendData(context.response, context.requestId, {
          entries: (await blocklist.list()).map((entry) => ({
            id: entry.id,
            indexerId: entry.indexerId,
            releaseTitle: entry.releaseTitle,
            ...(entry.targetTitle ? { targetTitle: entry.targetTitle } : {}),
            ...(entry.reason ? { reason: entry.reason } : {}),
            createdAt: new Date(entry.createdAtMs).toISOString(),
          })),
        });
      },
    },
    {
      method: "DELETE",
      path: "/releases/blocklist/:entryId",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const id = requireUuid(context.params.entryId, "entryId");
        if (!(await blocklist.remove(id))) {
          throw new OwnApiError("NOT_FOUND", "No such blocklist entry.", 404);
        }
        sendNoContent(context.response);
      },
    },
    {
      /**
       * Search for a target and judge everything found.
       *
       * Named `evaluate` rather than `grab` deliberately: it answers "what
       * would be chosen", and choosing is as far as this phase goes.
       */
      method: "POST",
      path: "/releases/evaluate",
      access: "admin",
      handle: async (context) => {
        context.requirePrincipal();
        const body = asObjectBody(await context.readJson(), BODY_KEYS);
        const target = parseTarget(body);
        const profileId = requireBodyString(body, "profileId", {
          maxLength: 64,
        });
        const indexerIds = optionalBodyStringArray(body, "indexerIds");
        const limit = optionalBodyInteger(body, "limit", { min: 1, max: 200 });

        const policy = await policies.load(profileId);
        if (!policy) {
          throw new OwnApiError(
            "PROFILE_NOT_FOUND",
            "No such quality profile.",
            404,
          );
        }

        const currentQualityId = optionalBodyString(body, "currentQualityId", {
          maxLength: 64,
        });
        const currentQuality =
          currentQualityId === undefined
            ? undefined
            : parseQualityId(currentQualityId);
        if (currentQualityId !== undefined && !currentQuality) {
          throw validationError("The currentQualityId is not a quality.");
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        context.request.once("aborted", abort);
        context.request.once("close", abort);
        try {
          const found = await search.search(searchFor(target, limit), {
            ...(indexerIds?.length ? { indexerIds } : {}),
            signal: controller.signal,
          });
          const isBlocklisted = await blocklist.matcherFor(found.releases);
          const result = selectRelease(target, found.releases, {
            profile: policy.profile,
            preferences: policy.preferences,
            isBlocklisted,
            current: currentQuality
              ? {
                  quality: currentQuality,
                  formatScore:
                    optionalBodyInteger(body, "currentFormatScore", {
                      min: -100_000,
                      max: 100_000,
                    }) ?? 0,
                }
              : null,
          });

          sendData(context.response, context.requestId, {
            target,
            profile: { id: policy.profile.id, name: policy.profile.name },
            indexers: found.outcomes,
            partial: found.partial,
            candidates: result.candidates.map(toDecisionDto),
            // The whole point, and still only a statement: nothing is fetched.
            winner:
              result.winner === undefined ? null : toDecisionDto(result.winner),
          });
        } catch (error) {
          if (error instanceof IndexerError) {
            throw new OwnApiError(
              "INDEXER_UNAVAILABLE",
              error.message,
              error.kind === "auth" ? 502 : 503,
            );
          }
          throw error;
        } finally {
          context.request.off("aborted", abort);
          context.request.off("close", abort);
        }
      },
    },
  ];
}
