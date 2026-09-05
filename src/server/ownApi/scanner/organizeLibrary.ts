import { TITLE_SOURCE_DIRECTORY } from "../../../renditions/adaptive/layout";
import type { LibraryKind, ScanDirectoryEntry } from "./libraryScan";
import {
  isExtraDirectory,
  isIgnoredEntry,
  isSampleFile,
  isSubtitleFile,
  isTrailerFile,
  isVideoFile,
  parseMovieName,
  parseSeasonFolder,
  parseSubtitleSuffix,
  splitExtension,
} from "./nameParser";

/**
 * Tidying a media folder into the shape the rest of the server already assumes.
 *
 * A half-processed season folder is the worst thing to open: ten sources, ten
 * subtitles, ten .nfo files and ten generated folders, interleaved by name so
 * that nothing lines up. Organising it moves the originals into one `src/`
 * bucket and files each episode's .nfo inside the folder that already holds
 * that episode's renditions, leaving one entry per episode plus the bucket:
 *
 * ```
 * Season 1/
 *   season.nfo
 *   src/
 *     House of the Dragon - S01E01 - The Heirs of the Dragon.mp4
 *     House of the Dragon - S01E01 - The Heirs of the Dragon.tr.srt
 *   House of the Dragon - S01E01 - The Heirs of the Dragon/
 *     House of the Dragon - S01E01 - The Heirs of the Dragon.nfo
 *     video/ audio/ subtitle/ .seyirlik/
 * ```
 *
 * A movie has no season above it and no episode below it, so its folder *is*
 * the title: the originals go to `Gladiator (2000)/src/` and the .nfo stays at
 * the folder root where Kodi and Jellyfin look for it.
 *
 * Two properties make this safe to run on every scan:
 *
 * 1. **No identity changes.** Every source key the scanner derives is computed
 *    from a title folder, and no title folder moves. `src/` is transparent to
 *    the scanner and to `titleRoot.ts`, so a package published yesterday is
 *    still that source's package after the move.
 * 2. **Nothing is ever overwritten or deleted.** A move whose destination is
 *    occupied is reported and skipped, so the worst outcome of a surprise is a
 *    folder that stayed as it was.
 *
 * Planning is separated from applying because the plan is the thing worth
 * reading before letting anything near a media volume — it is what
 * `npm run media:organize:plan` prints.
 */

export type OrganizeMoveReason =
  /** An original the title was built from. */
  | "source"
  /** A subtitle sitting beside that original. */
  | "sidecar"
  /** An .nfo belonging to a title that owns a folder. */
  | "metadata";

export interface OrganizeMove {
  from: string;
  to: string;
  reason: OrganizeMoveReason;
}

export type OrganizeSkipReason = "destination-occupied" | "unreadable";

export interface OrganizeSkip {
  relativePath: string;
  reason: OrganizeSkipReason;
}

export interface OrganizePlan {
  /** Every move, ordered by destination so a printed plan reads by folder. */
  moves: OrganizeMove[];
  /** Directories the moves need, deepest last, ready to be created in order. */
  directories: string[];
  skipped: OrganizeSkip[];
}

/** Reading is all planning needs; the executor is the only thing that writes. */
export interface OrganizerReadFileSystem {
  readDirectory(relativePath: string): Promise<ScanDirectoryEntry[]>;
}

export interface OrganizerFileSystem extends OrganizerReadFileSystem {
  createDirectory(relativePath: string): Promise<void>;
  /** Must refuse rather than replace when `to` already exists. */
  move(from: string, to: string): Promise<void>;
}

export interface PlanLibraryOrganizationOptions {
  fileSystem: OrganizerReadFileSystem;
  /** Library root, relative to the media root. */
  rootPath: string;
  kind: LibraryKind;
}

const MAX_ORGANIZE_DEPTH = 12;

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

interface FolderFile {
  name: string;
  relativePath: string;
  /** True when the file already sits in the folder's `src/` bucket. */
  inSourceDirectory: boolean;
}

interface FolderContents {
  directories: string[];
  /** Features, trailers excluded: only what a title is actually built from. */
  features: FolderFile[];
  subtitles: FolderFile[];
  /** .nfo files lying at the folder root, where they can still be moved. */
  metadata: FolderFile[];
  hasSourceDirectory: boolean;
}

const EMPTY_FOLDER: FolderContents = {
  directories: [],
  features: [],
  subtitles: [],
  metadata: [],
  hasSourceDirectory: false,
};

function isMetadataFile(name: string): boolean {
  return splitExtension(name).extension === "nfo";
}

/**
 * One folder as the organiser sees it: its own entries plus its `src/` bucket,
 * which is read so that an already-organised folder plans no moves at all.
 */
async function readFolder(
  fs: OrganizerReadFileSystem,
  directory: string,
  skipped: OrganizeSkip[],
): Promise<FolderContents> {
  let entries: ScanDirectoryEntry[];
  try {
    entries = await fs.readDirectory(directory);
  } catch {
    skipped.push({ relativePath: directory, reason: "unreadable" });
    return { ...EMPTY_FOLDER, directories: [] };
  }

  const contents: FolderContents = {
    directories: [],
    features: [],
    subtitles: [],
    metadata: [],
    hasSourceDirectory: false,
  };

  const classify = (
    name: string,
    directoryPath: string,
    inSourceDirectory: boolean,
  ): void => {
    const file: FolderFile = {
      name,
      relativePath: joinRelative(directoryPath, name),
      inSourceDirectory,
    };
    const { stem } = splitExtension(name);
    if (isSampleFile(stem)) return;
    if (isVideoFile(name)) {
      // A trailer is not the thing the title was built from and has its own
      // conventions; it stays exactly where the person who added it put it.
      if (!isTrailerFile(stem)) contents.features.push(file);
      return;
    }
    if (isSubtitleFile(name)) contents.subtitles.push(file);
    else if (isMetadataFile(name) && !inSourceDirectory)
      contents.metadata.push(file);
  };

  for (const entry of entries) {
    if (isIgnoredEntry(entry.name)) continue;
    if (entry.isDirectory) {
      if (entry.name.toLowerCase() === TITLE_SOURCE_DIRECTORY) {
        contents.hasSourceDirectory = true;
        continue;
      }
      contents.directories.push(entry.name);
      continue;
    }
    classify(entry.name, directory, false);
  }

  if (contents.hasSourceDirectory) {
    const bucket = joinRelative(directory, TITLE_SOURCE_DIRECTORY);
    try {
      for (const entry of await fs.readDirectory(bucket)) {
        if (entry.isDirectory || isIgnoredEntry(entry.name)) continue;
        classify(entry.name, bucket, true);
      }
    } catch {
      skipped.push({ relativePath: bucket, reason: "unreadable" });
    }
  }

  contents.directories.sort();
  return contents;
}

/** The names already taken in a directory, for refusing to overwrite. */
async function occupants(
  fs: OrganizerReadFileSystem,
  directory: string,
): Promise<Set<string>> {
  try {
    return new Set(
      (await fs.readDirectory(directory)).map((entry) =>
        entry.name.toLowerCase(),
      ),
    );
  } catch {
    // A directory that does not exist yet can hold nothing, which is exactly
    // what a caller planning to create it needs to hear.
    return new Set();
  }
}

/**
 * The moves one title's files need.
 *
 * `titleRoot` is the folder the title owns — the movie folder, or the folder an
 * episode's renditions are published into. `sourceRoot` is the folder whose
 * `src/` bucket the originals belong in, which is the same folder for a movie
 * and the season folder above for an episode.
 */
interface TitleGroup {
  titleRoot: string;
  sourceRoot: string;
  stem: string;
  features: FolderFile[];
}

class PlanBuilder {
  readonly moves: OrganizeMove[] = [];
  readonly skipped: OrganizeSkip[] = [];
  private readonly directories = new Set<string>();
  /** Destinations already claimed by this plan, so two files cannot collide. */
  private readonly claimed = new Set<string>();

  constructor(private readonly fs: OrganizerReadFileSystem) {}

  async move(
    file: FolderFile,
    destinationDirectory: string,
    reason: OrganizeMoveReason,
  ): Promise<void> {
    const to = joinRelative(destinationDirectory, file.name);
    if (to === file.relativePath) return;

    const taken = await occupants(this.fs, destinationDirectory);
    if (
      taken.has(file.name.toLowerCase()) ||
      this.claimed.has(to.toLowerCase())
    ) {
      this.skipped.push({
        relativePath: file.relativePath,
        reason: "destination-occupied",
      });
      return;
    }

    this.claimed.add(to.toLowerCase());
    this.directories.add(destinationDirectory);
    this.moves.push({ from: file.relativePath, to, reason });
  }

  build(): OrganizePlan {
    const moves = [...this.moves].sort(
      (left, right) =>
        left.to.localeCompare(right.to) || left.from.localeCompare(right.from),
    );
    // Shallowest first: creating `a/b` before `a` would rely on the executor
    // being recursive, and a plan that reads correctly does not need it to be.
    const directories = [...this.directories].sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        left.localeCompare(right),
    );
    return { moves, directories, skipped: this.skipped };
  }
}

/**
 * Group a folder's features the way the scanner groups them into items.
 *
 * A folder holding one title is that title. A folder holding several distinct
 * titles — or a library root, where loose files sit — is a container, and each
 * file becomes a title of its own in a folder named after it. Following the
 * scanner exactly here is what keeps every source key unchanged.
 */
function movieGroups(
  directory: string,
  features: FolderFile[],
  isContainer: boolean,
): TitleGroup[] {
  const distinctTitles = new Set(
    features.map((file) =>
      parseMovieName(splitExtension(file.name).stem).title.toLowerCase(),
    ),
  );
  if (!isContainer && distinctTitles.size <= 1) {
    return [
      {
        titleRoot: directory,
        sourceRoot: directory,
        stem: directory.split("/").pop() ?? directory,
        features,
      },
    ];
  }
  return features.map((file) => {
    const { stem } = splitExtension(file.name);
    const titleRoot = joinRelative(directory, stem);
    return { titleRoot, sourceRoot: titleRoot, stem, features: [file] };
  });
}

/** An episode's folder is named after its own file, inside the season folder. */
function episodeGroups(
  directory: string,
  features: FolderFile[],
): TitleGroup[] {
  return features.map((file) => {
    const { stem } = splitExtension(file.name);
    return {
      titleRoot: joinRelative(directory, stem),
      sourceRoot: directory,
      stem,
      features: [file],
    };
  });
}

/**
 * Plan one folder, given how its titles are grouped.
 *
 * `metadataDestination` is the one thing that differs between a movie folder
 * and a season folder: a movie's .nfo already lies at its title root and stays
 * there, while an episode's lies loose in a folder it shares with every other
 * episode and belongs one level down.
 */
async function planGroups(
  plan: PlanBuilder,
  contents: FolderContents,
  groups: TitleGroup[],
  moveMetadata: boolean,
): Promise<void> {
  const stemsByLowercase = new Map<string, TitleGroup>();
  for (const group of groups) {
    for (const file of group.features) {
      stemsByLowercase.set(splitExtension(file.name).stem.toLowerCase(), group);
    }
  }

  for (const group of groups) {
    const bucket = joinRelative(group.sourceRoot, TITLE_SOURCE_DIRECTORY);
    for (const file of group.features) {
      if (file.inSourceDirectory) continue;
      await plan.move(file, bucket, "source");
    }
  }

  for (const subtitle of contents.subtitles) {
    if (subtitle.inSourceDirectory) continue;
    const base = parseSubtitleSuffix(splitExtension(subtitle.name).stem);
    const group = stemsByLowercase.get(base.baseStem.toLowerCase());
    // A subtitle matching no source is somebody else's file, not a sidecar.
    if (!group) continue;
    await plan.move(
      subtitle,
      joinRelative(group.sourceRoot, TITLE_SOURCE_DIRECTORY),
      "sidecar",
    );
  }

  if (!moveMetadata) return;

  for (const file of contents.metadata) {
    const group = stemsByLowercase.get(
      splitExtension(file.name).stem.toLowerCase(),
    );
    // `season.nfo` and `tvshow.nfo` name no source and belong where they are.
    if (!group) continue;
    await plan.move(file, group.titleRoot, "metadata");
  }
}

async function planMovieTree(
  fs: OrganizerReadFileSystem,
  plan: PlanBuilder,
  directory: string,
  depth: number,
  isLibraryRoot: boolean,
  recurse = true,
): Promise<void> {
  if (depth > MAX_ORGANIZE_DEPTH) return;

  const contents = await readFolder(fs, directory, plan.skipped);
  if (contents.features.length > 0) {
    const groups = movieGroups(directory, contents.features, isLibraryRoot);
    // A movie's .nfo is only worth moving when the movie gains a folder it did
    // not have; inside a title folder it is already exactly where Kodi looks.
    const gainsFolder = groups.some((group) => group.titleRoot !== directory);
    await planGroups(plan, contents, groups, gainsFolder);
  }

  if (!recurse) return;
  for (const child of contents.directories) {
    if (isExtraDirectory(child)) continue;
    await planMovieTree(
      fs,
      plan,
      joinRelative(directory, child),
      depth + 1,
      false,
    );
  }
}

async function planSeriesFolder(
  fs: OrganizerReadFileSystem,
  plan: PlanBuilder,
  directory: string,
): Promise<void> {
  const contents = await readFolder(fs, directory, plan.skipped);
  // Episodes sitting directly in the series folder, the flat layout.
  await planGroups(
    plan,
    contents,
    episodeGroups(directory, contents.features),
    true,
  );

  for (const child of contents.directories) {
    if (isExtraDirectory(child)) continue;
    const childPath = joinRelative(directory, child);
    const childContents = await readFolder(fs, childPath, plan.skipped);
    await planGroups(
      plan,
      childContents,
      episodeGroups(childPath, childContents.features),
      true,
    );
  }
}

/**
 * What organising this library would do, without doing any of it.
 *
 * The traversal mirrors `scanLibraryTree` folder for folder, because a folder
 * the two disagree about is a folder where the organiser would move a file the
 * scanner then reads as a different title.
 */
export async function planLibraryOrganization({
  fileSystem,
  rootPath,
  kind,
}: PlanLibraryOrganizationOptions): Promise<OrganizePlan> {
  const plan = new PlanBuilder(fileSystem);
  const root = rootPath.replace(/^\/+|\/+$/g, "");

  // A book is a single file with no renditions and no sidecars; there is
  // nothing about its folder that organising would improve.
  if (kind === "books") return plan.build();

  if (kind === "series") {
    const contents = await readFolder(fileSystem, root, plan.skipped);
    for (const child of contents.directories) {
      if (isExtraDirectory(child)) continue;
      await planSeriesFolder(fileSystem, plan, joinRelative(root, child));
    }
    return plan.build();
  }

  if (kind === "mixed") {
    const contents = await readFolder(fileSystem, root, plan.skipped);
    for (const child of contents.directories) {
      if (isExtraDirectory(child)) continue;
      const childPath = joinRelative(root, child);
      const childContents = await readFolder(
        fileSystem,
        childPath,
        plan.skipped,
      );
      const looksLikeSeries = childContents.directories.some(
        (grandchild) => parseSeasonFolder(grandchild) !== undefined,
      );
      if (looksLikeSeries) {
        await planSeriesFolder(fileSystem, plan, childPath);
      } else {
        await planMovieTree(fileSystem, plan, childPath, 1, false);
      }
    }
    await planMovieTree(fileSystem, plan, root, 0, true, false);
    return plan.build();
  }

  await planMovieTree(fileSystem, plan, root, 0, true);
  return plan.build();
}

/**
 * Keeps the catalogue's file rows on the files the organiser moved.
 *
 * A source that moved is the same source: the same bytes, the same probe, the
 * same processing history. Without this the scan that follows would read the
 * new path as a new file and the old one as a file that vanished, replacing a
 * row identity that half the server points at for no reason at all.
 */
export interface OrganizedFileRecorder {
  /** Returns how many rows actually moved with their file. */
  recordMoves(moves: OrganizeMove[]): Promise<number>;
}

export interface OrganizeApplyResult {
  moved: OrganizeMove[];
  failed: Array<{ move: OrganizeMove; error: string }>;
  directoriesCreated: string[];
}

/**
 * Carry out a plan, stopping at nothing and destroying nothing.
 *
 * One move that fails — a permission, a file opened by something else, a disk
 * that went away — must not abandon the rest half-done in a way that needs a
 * human to reason about ordering, so each move is independent and a failure is
 * recorded rather than thrown. The scan that follows reads whatever state the
 * volume is actually in.
 */
export async function applyOrganizationPlan(
  fileSystem: OrganizerFileSystem,
  plan: OrganizePlan,
): Promise<OrganizeApplyResult> {
  const result: OrganizeApplyResult = {
    moved: [],
    failed: [],
    directoriesCreated: [],
  };

  for (const directory of plan.directories) {
    try {
      await fileSystem.createDirectory(directory);
      result.directoriesCreated.push(directory);
    } catch (error) {
      // Every move into it will fail and say so; there is nothing else to do.
      void error;
    }
  }

  for (const move of plan.moves) {
    try {
      await fileSystem.move(move.from, move.to);
      result.moved.push(move);
    } catch (error) {
      result.failed.push({
        move,
        error: error instanceof Error ? error.message : "The move failed.",
      });
    }
  }

  return result;
}
