/**
 * The download client, read once at startup.
 *
 * The key lives in the protected secrets file and is named here rather than
 * held here, the same arrangement the indexers use — so rotating it is editing
 * one value the service can read, and nothing in this file changes.
 */
export interface SabnzbdConfig {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  /**
   * The SABnzbd category Seyirlik files its jobs under.
   *
   * The ownership marker. Radarr, Sonarr and anything a person adds by hand
   * use their own, so a category plus a job name only Seyirlik would generate
   * is what keeps this from ever touching somebody else's download.
   */
  readonly category: string;
  readonly timeoutMs?: number;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const CATEGORY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function fail(message: string): never {
  throw new Error(`SEYIRLIK_SABNZBD is invalid: ${message}`);
}

/**
 * Parses the declaration, and proves the key exists.
 *
 * Absent configuration is not an error: a server with no download client is a
 * perfectly good media server, and Phase 4 is additive. A *declared* client
 * with no key is an error, because it would otherwise present as downloads
 * that silently never start.
 */
export function parseSabnzbdConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SabnzbdConfig | undefined {
  const raw = environment.SEYIRLIK_SABNZBD?.trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("it is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("it must be an object.");
  }
  const entry = parsed as Record<string, unknown>;

  const baseUrl = typeof entry.baseUrl === "string" ? entry.baseUrl.trim() : "";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    fail("it needs an absolute baseUrl.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail("it needs an http or https baseUrl.");
  }

  const apiKeyEnv =
    typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv.trim() : "";
  if (!ENV_NAME.test(apiKeyEnv)) {
    fail("it needs an apiKeyEnv naming the variable that holds the key.");
  }
  if (!environment[apiKeyEnv]?.trim()) {
    fail(`${apiKeyEnv} is empty.`);
  }

  const category =
    typeof entry.category === "string" && entry.category.trim()
      ? entry.category.trim().toLowerCase()
      : "seyirlik";
  if (!CATEGORY.test(category)) {
    fail(
      "the category may hold lowercase letters, digits, dot, dash and underscore.",
    );
  }

  const timeoutMs = entry.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0)
  ) {
    fail("timeoutMs must be a positive whole number of milliseconds.");
  }

  return {
    baseUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    apiKeyEnv,
    category,
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  };
}
