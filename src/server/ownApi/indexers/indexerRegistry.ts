/**
 * The configured indexers as live providers, plus what has happened to each.
 *
 * Status is held here rather than in the database: it is observation of an
 * external service, it is worthless after a restart, and writing it would put
 * a second source of truth beside the configuration it describes.
 */
import { createNewznabProvider } from "./newznabProvider";
import {
  IndexerError,
  type IndexerCapabilities,
  type IndexerProvider,
  type IndexerSearchQuery,
  type IndexerSearchResult,
} from "./indexerTypes";
import type { IndexerConfigEntry } from "./indexerConfig";

export interface IndexerStatus {
  readonly id: string;
  readonly name: string;
  readonly protocol: string;
  readonly enabled: boolean;
  readonly lastSuccessAtMs?: number;
  readonly lastErrorAtMs?: number;
  readonly lastErrorKind?: string;
  /** The provider's own words, never its response body. */
  readonly lastErrorMessage?: string;
}

export interface IndexerRegistry {
  list(): IndexerStatus[];
  /** Enabled providers, in configured order. */
  enabled(): IndexerProvider[];
  get(id: string): IndexerProvider | undefined;
  capabilities(id: string, signal?: AbortSignal): Promise<IndexerCapabilities>;
  /** Default categories for a search kind, when the caller names none. */
  defaultCategories(
    id: string,
    kind: IndexerSearchQuery["kind"],
  ): readonly number[];
  search(
    id: string,
    query: IndexerSearchQuery,
    signal?: AbortSignal,
  ): Promise<IndexerSearchResult>;
}

export interface CreateIndexerRegistryOptions {
  readonly entries: readonly IndexerConfigEntry[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

interface SlotStatus {
  lastSuccessAtMs?: number;
  lastErrorAtMs?: number;
  lastErrorKind?: string;
  lastErrorMessage?: string;
}

interface Slot {
  readonly entry: IndexerConfigEntry;
  readonly provider: IndexerProvider;
  status: SlotStatus;
}

export function createIndexerRegistry({
  entries,
  environment = process.env,
  fetchImpl,
  now = Date.now,
}: CreateIndexerRegistryOptions): IndexerRegistry {
  const slots = new Map<string, Slot>();
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const apiKey = environment[entry.apiKeyEnv]?.trim() ?? "";
    slots.set(entry.id, {
      entry,
      provider: createNewznabProvider({
        id: entry.id,
        name: entry.name,
        baseUrl: entry.baseUrl,
        apiPath: entry.apiPath,
        apiKey,
        protocol: entry.protocol,
        ...(entry.timeoutMs === undefined
          ? {}
          : { timeoutMs: entry.timeoutMs }),
        ...(fetchImpl ? { fetchImpl } : {}),
        now,
      }),
      status: {},
    });
  }

  async function observed<T>(id: string, run: () => Promise<T>): Promise<T> {
    const slot = slots.get(id);
    if (!slot) {
      throw new IndexerError("not-found", "No such indexer is configured.");
    }
    try {
      const result = await run();
      slot.status = { lastSuccessAtMs: now() };
      return result;
    } catch (error) {
      const failure =
        error instanceof IndexerError
          ? error
          : new IndexerError(
              "unavailable",
              "The provider could not be reached.",
            );
      slot.status = {
        ...slot.status,
        lastErrorAtMs: now(),
        lastErrorKind: failure.kind,
        lastErrorMessage: failure.message,
      };
      throw failure;
    }
  }

  return {
    list(): IndexerStatus[] {
      return entries.map((entry) => {
        const status = slots.get(entry.id)?.status;
        return {
          id: entry.id,
          name: entry.name,
          protocol: entry.protocol,
          enabled: entry.enabled,
          ...(status?.lastSuccessAtMs === undefined
            ? {}
            : { lastSuccessAtMs: status.lastSuccessAtMs }),
          ...(status?.lastErrorAtMs === undefined
            ? {}
            : {
                lastErrorAtMs: status.lastErrorAtMs,
                lastErrorKind: status.lastErrorKind ?? "unavailable",
                lastErrorMessage: status.lastErrorMessage ?? "",
              }),
        };
      });
    },
    enabled: () => [...slots.values()].map((slot) => slot.provider),
    get: (id) => slots.get(id)?.provider,
    capabilities: (id, signal) =>
      observed(id, async () => {
        const slot = slots.get(id);
        if (!slot) {
          throw new IndexerError("not-found", "No such indexer is configured.");
        }
        return slot.provider.capabilities(signal);
      }),
    defaultCategories(id, kind) {
      const entry = slots.get(id)?.entry;
      if (!entry) return [];
      if (kind === "movie") return entry.categories.movie;
      if (kind === "tv") return entry.categories.tv;
      return [];
    },
    search: (id, query, signal) =>
      observed(id, async () => {
        const slot = slots.get(id);
        if (!slot) {
          throw new IndexerError("not-found", "No such indexer is configured.");
        }
        return slot.provider.search(query, signal);
      }),
  };
}
