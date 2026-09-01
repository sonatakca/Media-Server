/**
 * NFO export policy, parsed once at startup.
 *
 * NFO sidecars are part of a normal library scan. The safe boundary is the
 * overwrite policy: an existing file that this exporter did not write is never
 * replaced. Operators who do not want sidecars can explicitly disable them.
 */

type Environment = Record<string, string | undefined>;

/**
 * Where exported files land.
 *
 * - `disabled` — nothing is generated; this is the explicit opt-out.
 * - `preview`  — XML can be produced and inspected through the API, but no
 *                file is ever written, anywhere.
 * - `generated`— files are written under generated storage, mirroring the media
 *                layout. The media root is untouched, so the export can be
 *                reviewed, rsynced, or thrown away.
 * - `sidecar`  — files are written next to the media, which is the only layout
 *                Kodi and Jellyfin actually read. This is the default.
 */
export type NfoExportMode = "disabled" | "preview" | "generated" | "sidecar";

/**
 * - `managed-only` — replace only files carrying this exporter's marker.
 * - `force`        — replace any .nfo, including a hand-written or legacy one.
 */
export type NfoOverwritePolicy = "managed-only" | "force";

export interface NfoConfig {
  mode: NfoExportMode;
  overwritePolicy: NfoOverwritePolicy;
  /**
   * Libraries whose .nfo files a Radarr/Sonarr instance owns, by slug.
   *
   * Native export refuses to touch them. Two writers taking turns on one path
   * is not a merge, it is a fight, and the loser is whichever ran first.
   */
  arrManagedLibrarySlugs: ReadonlySet<string>;
}

const MODES: NfoExportMode[] = ["disabled", "preview", "generated", "sidecar"];
const POLICIES: NfoOverwritePolicy[] = ["managed-only", "force"];

export const NFO_DEFAULT_CONFIG: NfoConfig = {
  mode: "sidecar",
  overwritePolicy: "managed-only",
  arrManagedLibrarySlugs: new Set(),
};

function parseChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  variable: string,
  fallback: T,
): T {
  const raw = value?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  const match = allowed.find((candidate) => candidate === raw);
  if (!match) {
    throw new Error(`${variable} must be one of ${allowed.join(", ")}.`);
  }
  return match;
}

/**
 * Reads the policy, and refuses to start on a combination that would surprise.
 *
 * A misconfiguration here is not something to discover later from a diff on the
 * media volume, so an unusable combination stops the process with a message
 * naming the variable to fix.
 */
export function parseNfoConfig(
  environment: Environment = process.env,
): NfoConfig {
  const mode = parseChoice(
    environment.SEYIRLIK_NFO_EXPORT,
    MODES,
    "SEYIRLIK_NFO_EXPORT",
    "sidecar",
  );
  const overwritePolicy = parseChoice(
    environment.SEYIRLIK_NFO_OVERWRITE,
    POLICIES,
    "SEYIRLIK_NFO_OVERWRITE",
    "managed-only",
  );

  const arrManagedLibrarySlugs = new Set(
    (environment.SEYIRLIK_NFO_ARR_MANAGED_LIBRARIES ?? "")
      .split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter((slug) => slug.length > 0),
  );

  return { mode, overwritePolicy, arrManagedLibrarySlugs };
}

/** Whether this mode puts bytes on a disk at all. */
export function writesFiles(mode: NfoExportMode): boolean {
  return mode === "generated" || mode === "sidecar";
}
