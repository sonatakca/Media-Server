/**
 * One search across the configured indexers.
 *
 * Ordering here is deliberately not release selection. It is newest first, ties
 * broken by indexer and identifier so the same inputs always produce the same
 * page. Deciding which of two releases is *better* — resolution, source, codec,
 * group, size against a profile — is a later phase, and putting a fragment of
 * that here would leave two ranking rules to reconcile when it arrives.
 */
import {
  IndexerError,
  type IndexerRelease,
  type IndexerSearchQuery,
} from "./indexerTypes";
import type { IndexerRegistry } from "./indexerRegistry";

export interface IndexerOutcome {
  readonly indexerId: string;
  readonly indexerName: string;
  readonly ok: boolean;
  readonly returned: number;
  readonly totalAvailable?: number;
  readonly errorKind?: string;
  readonly errorMessage?: string;
}

export interface AggregatedSearch {
  readonly releases: readonly IndexerRelease[];
  readonly outcomes: readonly IndexerOutcome[];
  /** True when some indexer failed while at least one answered. */
  readonly partial: boolean;
}

export interface SearchOptions {
  readonly indexerIds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface IndexerSearchService {
  search(
    query: IndexerSearchQuery,
    options?: SearchOptions,
  ): Promise<AggregatedSearch>;
}

export function createIndexerSearchService(
  registry: IndexerRegistry,
): IndexerSearchService {
  return {
    async search(query, options = {}) {
      const statuses = registry.list();
      const enabledIds = registry.enabled().map((provider) => provider.id);
      const requested = options.indexerIds?.length
        ? enabledIds.filter((id) => options.indexerIds!.includes(id))
        : enabledIds;

      if (requested.length === 0) {
        throw new IndexerError(
          "not-found",
          "No enabled indexer matches this search.",
        );
      }

      const settled = await Promise.all(
        requested.map(async (id) => {
          const name = statuses.find((status) => status.id === id)?.name ?? id;
          // A caller that named no categories gets the ones configured for
          // this indexer and this kind, not a guess made further down.
          const categoryIds = query.categoryIds?.length
            ? query.categoryIds
            : registry.defaultCategories(id, query.kind);
          try {
            const result = await registry.search(
              id,
              {
                ...query,
                ...(categoryIds.length ? { categoryIds } : {}),
              },
              options.signal,
            );
            return {
              outcome: {
                indexerId: id,
                indexerName: name,
                ok: true,
                returned: result.releases.length,
                ...(result.totalAvailable === undefined
                  ? {}
                  : { totalAvailable: result.totalAvailable }),
              } satisfies IndexerOutcome,
              releases: [...result.releases],
            };
          } catch (error) {
            const failure =
              error instanceof IndexerError
                ? error
                : new IndexerError(
                    "unavailable",
                    "The provider could not be reached.",
                  );
            return {
              outcome: {
                indexerId: id,
                indexerName: name,
                ok: false,
                returned: 0,
                errorKind: failure.kind,
                errorMessage: failure.message,
              } satisfies IndexerOutcome,
              releases: [] as IndexerRelease[],
            };
          }
        }),
      );

      /*
       * Deduplication is per indexer, by the identifier that indexer promised
       * is stable. The same film from two indexers is two different things to
       * acquire from two different providers, and collapsing them here would
       * discard the alternative before anything had judged either.
       */
      const seen = new Set<string>();
      const releases: IndexerRelease[] = [];
      for (const { releases: batch } of settled) {
        for (const release of batch) {
          const key = `${release.indexerId}::${release.guid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          releases.push(release);
        }
      }

      releases.sort((left, right) => {
        const byDate = (right.publishedAtMs ?? 0) - (left.publishedAtMs ?? 0);
        if (byDate !== 0) return byDate;
        if (left.indexerId !== right.indexerId) {
          return left.indexerId < right.indexerId ? -1 : 1;
        }
        if (left.guid === right.guid) return 0;
        return left.guid < right.guid ? -1 : 1;
      });

      const outcomes = settled.map(({ outcome }) => outcome);
      if (outcomes.every((outcome) => !outcome.ok)) {
        const first = outcomes[0];
        throw new IndexerError(
          (first?.errorKind as IndexerError["kind"]) ?? "unavailable",
          first?.errorMessage ?? "No indexer answered the search.",
        );
      }
      return {
        releases,
        outcomes,
        partial: outcomes.some((outcome) => !outcome.ok),
      };
    },
  };
}
