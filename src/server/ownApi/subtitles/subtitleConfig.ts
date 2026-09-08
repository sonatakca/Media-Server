import path from "node:path";

export interface SubtitleConfig {
  readonly libraryRoot: string;
  readonly providerIds: readonly string[];
  readonly timeoutMs: number;
}

/** Explicit opt-in. Parsing never opens the configured root or contacts a provider. */
export function parseSubtitleConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SubtitleConfig | undefined {
  const raw = environment.SEYIRLIK_SUBTITLES?.trim();
  if (!raw) return undefined;
  const fail = (): never => {
    throw new Error(
      "SEYIRLIK_SUBTITLES requires an absolute libraryRoot, providerIds, and an optional bounded timeoutMs; secrets are not configuration fields.",
    );
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail();
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some(
      (key) => !["libraryRoot", "providerIds", "timeoutMs"].includes(key),
    )
  )
    return fail();
  if (
    typeof config.libraryRoot !== "string" ||
    !path.isAbsolute(config.libraryRoot) ||
    config.libraryRoot.includes("\0")
  )
    return fail();
  if (
    !Array.isArray(config.providerIds) ||
    config.providerIds.some(
      (id) => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id),
    ) ||
    new Set(config.providerIds).size !== config.providerIds.length
  )
    return fail();
  /*
   * An absent key defaults; an explicit `null` does not. Everything else in
   * this declaration is refused rather than ignored when it is not understood,
   * and a `null` where a number belongs is a mistake rather than a way of
   * saying "unset".
   */
  const timeoutMs = config.timeoutMs === undefined ? 30_000 : config.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 300_000
  )
    return fail();
  return {
    libraryRoot: path.resolve(config.libraryRoot),
    providerIds: config.providerIds,
    timeoutMs,
  };
}
