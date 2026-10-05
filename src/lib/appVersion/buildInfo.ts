/**
 * What one build of the frontend is, stamped in at build time.
 *
 * The same object is compiled into the bundle (`__SEYIRLIK_BUILD__`), written
 * beside it as `/version.json`, and named in index.html's
 * `<meta name="seyirlik-build">`. A tab compares the first with the second to
 * learn a newer build is live, and reads the third out of the service worker's
 * precache to learn whether that precache would still serve the old one.
 */
export interface BuildInfo {
  /** What a person reads: the build date, then the commit when known. */
  version: string;
  /** Unique to this build; the only field compared. */
  buildId: string;
  commit: string | null;
  builtAt: string;
}

export const BUILD_META_NAME = "seyirlik-build";

interface BuildFacts {
  commit: string | null;
  /** Tracked files differed from the commit when this was built. */
  dirty: boolean;
  builtAt: Date;
}

export function describeBuild({
  commit,
  dirty,
  builtAt,
}: BuildFacts): BuildInfo {
  const date = builtAt.toISOString().slice(0, 10).replaceAll("-", ".");
  const shortCommit = commit ? commit.slice(0, 7) : null;
  const source = shortCommit ? `${shortCommit}${dirty ? "+dirty" : ""}` : null;

  return {
    version: source ? `${date} · ${source}` : date,
    // Two builds of one commit can still differ (a dirty tree, another
    // environment), so the build time is part of the identity.
    buildId: `${source ?? "nogit"}-${builtAt.getTime().toString(36)}`,
    commit,
    builtAt: builtAt.toISOString(),
  };
}

/** The build named by an index.html, or null when it names none. */
export function readBuildIdFromHtml(html: string): string | null {
  const match = new RegExp(
    `<meta\\s+name="${BUILD_META_NAME}"\\s+content="([^"]+)"`,
  ).exec(html);
  return match ? match[1] : null;
}
