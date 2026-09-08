/**
 * Configured indexers, read once at startup.
 *
 * The declaration lives beside `SEYIRLIK_LIBRARIES` in the non-secret settings
 * file; each entry names the environment variable that holds its key, and the
 * key itself lives only in the protected secrets file. Rotation is then editing
 * one value the service can read and nothing else — no code change, no second
 * copy in the database to drift from this one.
 */
import type { IndexerProtocol } from "./indexerTypes";

export interface IndexerConfigEntry {
  readonly id: string;
  readonly name: string;
  readonly type: "newznab";
  readonly baseUrl: string;
  readonly apiPath: string;
  readonly protocol: IndexerProtocol;
  readonly enabled: boolean;
  /** The variable holding the key. Never the key. */
  readonly apiKeyEnv: string;
  /** Default categories per search kind, when the caller names none. */
  readonly categories: {
    readonly movie: readonly number[];
    readonly tv: readonly number[];
  };
  readonly timeoutMs?: number;
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

function fail(message: string): never {
  throw new Error(`SEYIRLIK_INDEXERS is invalid: ${message}`);
}

function categoryList(raw: unknown, where: string): number[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail(`${where} must be an array of category ids.`);
  return raw.map((value) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      fail(`${where} must contain whole category ids.`);
    }
    return value;
  });
}

/**
 * Parses the declaration and proves each entry can actually be used.
 *
 * A declared indexer whose key is missing is a mistake that would otherwise
 * surface as "the indexer returns nothing", which reads like an empty library
 * rather than a misconfiguration. It stops the process instead.
 */
export function parseIndexerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): IndexerConfigEntry[] {
  const raw = environment.SEYIRLIK_INDEXERS?.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("it is not valid JSON.");
  }
  if (!Array.isArray(parsed)) fail("it must be an array.");

  const entries: IndexerConfigEntry[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "object" || value === null)
      fail("each entry must be an object.");
    const entry = value as Record<string, unknown>;
    const id =
      typeof entry.id === "string" ? entry.id.trim().toLowerCase() : "";
    if (!ID.test(id))
      fail("each entry needs an id of lowercase letters, digits and hyphens.");
    if (seen.has(id)) fail(`the id ${id} appears more than once.`);
    seen.add(id);
    if (entry.type !== undefined && entry.type !== "newznab") {
      fail(`the indexer ${id} has a type this build does not implement.`);
    }
    const name =
      typeof entry.name === "string" && entry.name.trim()
        ? entry.name.trim()
        : id;
    const baseUrl =
      typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      fail(`the indexer ${id} needs an absolute baseUrl.`);
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      fail(`the indexer ${id} needs an http or https baseUrl.`);
    }
    const apiKeyEnv =
      typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv.trim() : "";
    if (!ENV_NAME.test(apiKeyEnv)) {
      fail(
        `the indexer ${id} needs an apiKeyEnv naming the variable that holds its key.`,
      );
    }
    const enabled = entry.enabled === undefined ? true : entry.enabled === true;
    if (enabled && !environment[apiKeyEnv]?.trim()) {
      fail(`the indexer ${id} is enabled but ${apiKeyEnv} is empty.`);
    }
    const protocol: IndexerProtocol =
      entry.protocol === "torrent" ? "torrent" : "usenet";
    const categories = (entry.categories ?? {}) as Record<string, unknown>;
    const timeout = entry.timeoutMs;
    if (
      timeout !== undefined &&
      (typeof timeout !== "number" ||
        !Number.isInteger(timeout) ||
        timeout <= 0)
    ) {
      fail(
        `the indexer ${id} has a timeoutMs that is not a positive whole number of milliseconds.`,
      );
    }

    entries.push({
      id,
      name,
      type: "newznab",
      baseUrl: parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, ""),
      apiPath:
        typeof entry.apiPath === "string" && entry.apiPath.trim()
          ? entry.apiPath.trim()
          : "/api",
      protocol,
      enabled,
      apiKeyEnv,
      categories: {
        movie: categoryList(
          categories.movie,
          `the indexer ${id} categories.movie`,
        ),
        tv: categoryList(categories.tv, `the indexer ${id} categories.tv`),
      },
      ...(timeout === undefined ? {} : { timeoutMs: timeout as number }),
    });
  }
  return entries;
}
