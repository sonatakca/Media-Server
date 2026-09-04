import { access } from "node:fs/promises";
import path from "node:path";
import { TITLE_PACKAGE_DIRECTORY, TITLE_PACKAGE_MANIFEST } from "./titleLayout";

/**
 * Where a source's adaptive package lives.
 *
 * A package has always sat *beside* the file it was built from: `Movies/Dune
 * (2021)/Dune.mp4` publishes into `Movies/Dune (2021)/`. That holds because a
 * movie folder contains one movie, so the folder is the title.
 *
 * A season folder is not. `Series/Andor/Season 1/` holds twelve sources, and
 * publishing all twelve beside themselves would mean twelve packages writing
 * into one `video/`, one `audio/` and one `.seyirlik/manifest`, each silently
 * replacing the last. So an episode's package is *nested*: it goes in a folder
 * named after the source's own file stem, which is unique inside the season
 * folder for the same reason the file itself is.
 *
 * This is the single place that decision is made. Everything that writes a
 * package and everything that reads one resolves through here, so the two can
 * never disagree about where a title's bytes are.
 */

/**
 * `beside` is the movie layout and stays exactly as it was, so every package
 * already on disk keeps its address. `nested` is the episode layout.
 */
export type TitleRootLayout = "beside" | "nested";

/** The layout a catalogue item of this kind publishes under. */
export function titleRootLayoutForKind(kind: string): TitleRootLayout {
  return kind === "episode" ? "nested" : "beside";
}

/** The folder a `nested` source publishes into: `<dir>/<file stem>/`. */
export function nestedTitleRoot(sourcePath: string): string {
  const directory = path.dirname(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  /*
   * A stem that is empty or that would climb out of the directory is not a
   * name this can build a root from. Falling back to the directory keeps the
   * old behaviour rather than inventing a path outside the library.
   */
  if (!stem || stem === "." || stem === ".." || stem.includes(path.sep)) {
    return directory;
  }
  return path.join(directory, stem);
}

/** The folder a `beside` source publishes into: its own directory. */
export function besideTitleRoot(sourcePath: string): string {
  return path.dirname(sourcePath);
}

export function titleRootFor(
  sourcePath: string,
  layout: TitleRootLayout,
): string {
  return layout === "nested"
    ? nestedTitleRoot(sourcePath)
    : besideTitleRoot(sourcePath);
}

/**
 * Every root this source's package could occupy, most specific first.
 *
 * Readers that do not know the catalogue — playback resolves a package from a
 * file path alone — walk this list and take the first root that actually holds
 * a manifest. The nested root is checked first because it belongs to exactly
 * one source, while the directory beside it may be a season folder shared with
 * eleven other episodes.
 */
export function candidateTitleRoots(sourcePath: string): string[] {
  const nested = nestedTitleRoot(sourcePath);
  const beside = besideTitleRoot(sourcePath);
  return nested === beside ? [beside] : [nested, beside];
}

export function titleManifestPath(titleRoot: string): string {
  return path.join(titleRoot, TITLE_PACKAGE_DIRECTORY, TITLE_PACKAGE_MANIFEST);
}

/**
 * The root this source's package is actually at, or the layout's default when
 * there is no package yet.
 *
 * `fallbackLayout` decides what an absent package is called. A writer passes
 * the layout its catalogue kind implies; a reader that has no catalogue passes
 * `beside`, which is where every package written before this existed lives.
 */
export async function resolveTitleRoot(
  sourcePath: string,
  fallbackLayout: TitleRootLayout = "beside",
  exists: (candidate: string) => Promise<boolean> = defaultManifestExists,
): Promise<string> {
  /*
   * A caller that KNOWS this is a nested title — currently an episode — must
   * never inherit a package from the directory beside its source.
   *
   * That directory is a season folder shared by many episodes. Accepting its
   * manifest as a compatibility fallback makes one legacy S01E01 package look
   * like the package for S01E02, S01E03, and every other sibling.
   *
   * Readers without catalogue knowledge still use the beside/default path
   * below and may probe both candidates for legacy compatibility. Catalogue-
   * aware episode readers and writers are authoritative: their root is nested.
   */
  if (fallbackLayout === "nested") {
    return nestedTitleRoot(sourcePath);
  }

  for (const candidate of candidateTitleRoots(sourcePath)) {
    if (await exists(titleManifestPath(candidate))) return candidate;
  }
  return titleRootFor(sourcePath, fallbackLayout);
}

async function defaultManifestExists(manifestPath: string): Promise<boolean> {
  try {
    await access(manifestPath);
    return true;
  } catch {
    return false;
  }
}
