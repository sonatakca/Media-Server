import { access } from "node:fs/promises";
import path from "node:path";
import { TITLE_SOURCE_DIRECTORY } from "./layout";
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

/**
 * The directory a source's title is anchored to.
 *
 * Usually the directory the file is in. The exception is an organised library,
 * where the file has been moved down into a `src/` bucket beside its own
 * generated folders — there the title is the folder that *contains* `src`, so
 * that `Dune (2021)/src/Dune (2021).mp4` still belongs to `Dune (2021)/` and
 * `Season 1/src/Andor - S01E01.mp4` still belongs to `Season 1/`.
 *
 * Making `src/` transparent here is what lets a library be reorganised without
 * moving a single published package: every root computed below is unchanged by
 * the move.
 */
function titleBaseDirectoryIn(
  flavour: PathFlavour,
  sourcePath: string,
): string {
  const directory = flavour.dirname(sourcePath);
  if (flavour.basename(directory).toLowerCase() !== TITLE_SOURCE_DIRECTORY) {
    return directory;
  }
  const parent = flavour.dirname(directory);
  // A `src` at the very top of the tree has nothing above it to belong to.
  return parent === directory ? directory : parent;
}

function titleBaseDirectory(sourcePath: string): string {
  return titleBaseDirectoryIn(path, sourcePath);
}

function nestedTitleRootIn(flavour: PathFlavour, sourcePath: string): string {
  const directory = titleBaseDirectoryIn(flavour, sourcePath);
  const stem = flavour.basename(sourcePath, flavour.extname(sourcePath));
  /*
   * A stem that is empty or that would climb out of the directory is not a
   * name this can build a root from. Falling back to the directory keeps the
   * old behaviour rather than inventing a path outside the library.
   *
   * The separator comes from the flavour, not from the host: a `\\` is an
   * ordinary character in a POSIX filename and must stay one, and a `/` is an
   * ordinary character in no Windows filename at all.
   */
  if (!stem || stem === "." || stem === ".." || stem.includes(flavour.sep)) {
    return directory;
  }
  return flavour.join(directory, stem);
}

/** The folder a `nested` source publishes into: `<title base>/<file stem>/`. */
export function nestedTitleRoot(sourcePath: string): string {
  return nestedTitleRootIn(path, sourcePath);
}

/** The folder a `beside` source publishes into: the folder its title owns. */
export function besideTitleRoot(sourcePath: string): string {
  return titleBaseDirectory(sourcePath);
}

/** Where the originals belonging to `titleRoot` are kept once organised. */
export function titleSourceDirectory(titleRoot: string): string {
  return path.join(titleRoot, TITLE_SOURCE_DIRECTORY);
}

/**
 * The same two answers for a library-relative path.
 *
 * The scanner, the NFO planner and the organiser all reason in POSIX paths
 * relative to the media root and never see a host path, but they must place a
 * title exactly where the writers above place it. Sharing the rule rather than
 * the code would be the way these two drift apart.
 */
export function titleBaseDirectoryOf(relativePath: string): string {
  return titleBaseDirectoryIn(path.posix, toPosix(relativePath)).replace(
    /^\.$/,
    "",
  );
}

export function nestedTitleRootOf(relativePath: string): string {
  return nestedTitleRootIn(path.posix, toPosix(relativePath)).replace(
    /^\.$/,
    "",
  );
}

/**
 * The part of `node:path` these rules need, so the same rule can be applied in
 * either flavour.
 *
 * The two functions above take a **library-relative** path, which is POSIX
 * everywhere by contract — it is what the catalogue stores, what the scanner
 * emits, and what the NFO planner compares against. Normalising the input was
 * not enough: `path.win32.join` rewrites every separator, so on Windows
 * `nestedTitleRootOf("Series/Andor/Season 1/Andor - S01E01.mkv")` answered
 * `Series\Andor\Season 1\Andor - S01E01` — a key that matches nothing a
 * macOS deployment wrote, and would silently split a migrated library in two.
 *
 * So the flavour is chosen by the caller's contract rather than by the host:
 * `path` for the host paths above, `path.posix` for the relative ones.
 */
type PathFlavour = Pick<
  typeof path,
  "dirname" | "basename" | "extname" | "join" | "sep"
>;

/**
 * `path` is the host's separator; a library-relative path is always POSIX.
 * They agree everywhere this server runs, and this states the assumption
 * rather than leaving it to be discovered on a Windows box.
 */
function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
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
