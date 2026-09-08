/**
 * Reading a finished download, and deciding what of it Seyirlik will claim.
 *
 * Nothing here mutates anything. That is the point: a plan is produced, looked
 * at, and only then carried out, so the question "what is this import about to
 * do to my disk" has an answer before the disk is touched.
 *
 * The directory policy is deliberately not the scanner's. `isExtraDirectory`
 * counts `Subs/` and `Subtitles/` as extras, which is right for a library — a
 * folder of video files beside a film would otherwise scan as more films — and
 * wrong for a download, where that folder is exactly where the subtitles are.
 * The per-file helpers are shared; the directory rules are this module's own.
 */
import {
  isIgnoredEntry,
  isSampleFile,
  isSubtitleFile,
  isTrailerFile,
  isVideoFile,
  splitExtension,
} from "../scanner/nameParser";
import type { ImportFailureClass, ImportFileRole } from "./importState";

export interface ImportEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /**
   * A symlink, junction or other reparse point.
   *
   * Reported by the filesystem rather than inferred, because on Windows a
   * junction is what a crafted download would use to point the importer at
   * somewhere outside its root.
   */
  readonly isSymbolicLink: boolean;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * One authorised root, and nothing above it.
 *
 * The root is fixed when the filesystem is created rather than passed per
 * call, so there is no call site that could be given a different one.
 */
export interface RootedReadFileSystem {
  readonly root: string;
  /** Entries of a directory, by `lstat` so links are seen as links. */
  list(relative: string): Promise<ImportEntry[]>;
  /** Facts about one entry, or null when it is not there. */
  stat(relative: string): Promise<ImportEntry | null>;
}

export interface InspectedFile {
  readonly relative: string;
  readonly role: ImportFileRole;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export interface SourceInspection {
  readonly files: readonly InspectedFile[];
  /** The files this import would move. Empty is a problem, not a plan. */
  readonly media: readonly InspectedFile[];
  readonly subtitles: readonly InspectedFile[];
  readonly metadata: readonly InspectedFile[];
  readonly totalBytes: number;
  /** Set when the source cannot be imported as it stands. */
  readonly problem?: ImportFailureClass;
  readonly detail?: string;
}

/** Directories whose contents are a sample of the release, never the release. */
const SAMPLE_DIRECTORIES = new Set(["sample", "samples"]);

/** Directories of supplementary video that is not the feature. */
const EXTRA_DIRECTORIES = new Set([
  "extras",
  "featurettes",
  "behind the scenes",
  "deleted scenes",
  "interviews",
  "scenes",
  "shorts",
  "trailers",
  "other",
]);

/** Where a release keeps its subtitles. Descended into, not skipped. */
const SUBTITLE_DIRECTORIES = new Set(["subs", "subtitle", "subtitles"]);

const ARTWORK_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "tbn"]);

/** What unpacking left behind. Recognised, and deliberately not claimed. */
const LEFTOVER_EXTENSIONS = new Set([
  "rar",
  "zip",
  "7z",
  "tar",
  "gz",
  "par2",
  "sfv",
  "nzb",
  "url",
  "txt",
  "md5",
  "diz",
]);

function isLeftover(extension: string): boolean {
  // r00, r01 … are the continuation volumes of a split RAR.
  return LEFTOVER_EXTENSIONS.has(extension) || /^r\d{2,3}$/.test(extension);
}

/** What a directory name means for everything inside it. */
type DirectoryContext = "release" | "sample" | "extra" | "subtitles";

function contextFor(name: string, parent: DirectoryContext): DirectoryContext {
  // A sample inside extras is still a sample; the narrower context wins and
  // never widens back to `release` further down the tree.
  const folded = name.trim().toLowerCase();
  if (SAMPLE_DIRECTORIES.has(folded)) return "sample";
  if (EXTRA_DIRECTORIES.has(folded)) return "extra";
  if (SUBTITLE_DIRECTORIES.has(folded)) return "subtitles";
  return parent === "release" ? "release" : parent;
}

export function classifyFile(
  name: string,
  sizeBytes: number,
  context: DirectoryContext = "release",
): ImportFileRole {
  if (isIgnoredEntry(name)) return "ignored";
  const { stem, extension } = splitExtension(name);

  if (isVideoFile(name)) {
    if (context === "sample" || isSampleFile(stem)) return "sample";
    if (context === "extra") return "extra";
    if (isTrailerFile(stem)) return "trailer";
    /*
     * A zero-length video is recognised and declined rather than reported as
     * something strange. If it was the only candidate the import fails with
     * `no-media-found`, which is the honest complaint.
     */
    if (sizeBytes === 0) return "ignored";
    return "media";
  }

  if (isSubtitleFile(name)) {
    // A subtitle belonging to a sample is a sample's subtitle.
    return context === "sample" || context === "extra" ? context : "subtitle";
  }

  if (extension === "nfo") return "metadata";
  if (ARTWORK_EXTENSIONS.has(extension)) return "artwork";
  if (isLeftover(extension)) return "ignored";
  return "unclaimed";
}

export interface InspectSourceOptions {
  readonly fileSystem: RootedReadFileSystem;
  /** The download, relative to the authorised source root. */
  readonly relative: string;
  /** How deep a release may nest before it is refused. */
  readonly maxDepth?: number;
  /** How many entries may be examined before it is refused. */
  readonly maxEntries?: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ENTRIES = 5_000;

function join(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * What is in the download, and what this import would claim of it.
 *
 * Bounded on purpose. A release that nests deeper than `maxDepth` or holds
 * more than `maxEntries` is refused rather than walked, because an importer
 * that will walk anything is an importer that can be made to walk forever.
 */
export async function inspectSource({
  fileSystem,
  relative,
  maxDepth = DEFAULT_MAX_DEPTH,
  maxEntries = DEFAULT_MAX_ENTRIES,
}: InspectSourceOptions): Promise<SourceInspection> {
  const root = await fileSystem.stat(relative);
  if (!root) {
    return empty(
      "source-missing",
      "The download is not where the handoff said.",
    );
  }
  if (root.isSymbolicLink) {
    /*
     * The handoff itself being a link is refused outright rather than
     * followed. Containment would catch a link that pointed outside the root,
     * but a link that points *inside* it is still not the thing SABnzbd said
     * it downloaded.
     */
    return empty(
      "source-not-regular",
      "The download path is a link rather than a directory or file.",
    );
  }

  const files: InspectedFile[] = [];
  let examined = 0;

  async function walk(
    directory: string,
    context: DirectoryContext,
    depth: number,
  ): Promise<ImportFailureClass | undefined> {
    if (depth > maxDepth) return "no-media-found";
    for (const entry of await fileSystem.list(directory)) {
      examined += 1;
      if (examined > maxEntries) return "no-media-found";

      const entryPath = join(directory, entry.name);

      if (entry.isSymbolicLink) {
        // Never followed and never claimed, whatever it points at.
        files.push({
          relative: entryPath,
          role: "unclaimed",
          sizeBytes: entry.sizeBytes,
          mtimeMs: entry.mtimeMs,
        });
        continue;
      }

      if (entry.isDirectory) {
        if (isIgnoredEntry(entry.name)) continue;
        const failure = await walk(
          entryPath,
          contextFor(entry.name, context),
          depth + 1,
        );
        if (failure) return failure;
        continue;
      }

      files.push({
        relative: entryPath,
        role: classifyFile(entry.name, entry.sizeBytes, context),
        sizeBytes: entry.sizeBytes,
        mtimeMs: entry.mtimeMs,
      });
    }
    return undefined;
  }

  let overrun: ImportFailureClass | undefined;
  if (root.isDirectory) {
    overrun = await walk(relative, "release", 1);
  } else {
    files.push({
      relative,
      role: classifyFile(root.name, root.sizeBytes, "release"),
      sizeBytes: root.sizeBytes,
      mtimeMs: root.mtimeMs,
    });
  }

  const media = files.filter((file) => file.role === "media");
  const subtitles = files.filter((file) => file.role === "subtitle");
  const metadata = files.filter((file) => file.role === "metadata");
  const totalBytes = media.reduce((sum, file) => sum + file.sizeBytes, 0);

  const inspection: SourceInspection = {
    files,
    media,
    subtitles,
    metadata,
    totalBytes,
  };

  if (overrun) {
    return {
      ...inspection,
      problem: overrun,
      detail: "The download is deeper or larger than an import will walk.",
    };
  }
  if (media.length === 0) {
    return {
      ...inspection,
      problem: "no-media-found",
      detail: "Nothing in the download is a media file this import claims.",
    };
  }
  return inspection;
}

function empty(problem: ImportFailureClass, detail: string): SourceInspection {
  return {
    files: [],
    media: [],
    subtitles: [],
    metadata: [],
    totalBytes: 0,
    problem,
    detail,
  };
}

export interface StabilitySample {
  readonly relative: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

/**
 * Whether two observations of the same files agree.
 *
 * A pure comparison rather than a sleep, so the caller decides how the gap
 * between the two is produced and the rule itself is testable without waiting
 * for anything. A file that grew, shrank, was rewritten, or vanished between
 * the samples is not a file to start hardlinking.
 */
export function isQuiescent(
  before: readonly StabilitySample[],
  after: readonly StabilitySample[],
): boolean {
  if (before.length !== after.length) return false;
  const seen = new Map(after.map((sample) => [sample.relative, sample]));
  return before.every((sample) => {
    const later = seen.get(sample.relative);
    return (
      later !== undefined &&
      later.sizeBytes === sample.sizeBytes &&
      later.mtimeMs === sample.mtimeMs
    );
  });
}

export function samplesOf(
  inspection: SourceInspection,
): readonly StabilitySample[] {
  // Only the files that would be moved. A changing `.nfo` beside a finished
  // film is not a reason to refuse the film.
  return inspection.media.map((file) => ({
    relative: file.relative,
    sizeBytes: file.sizeBytes,
    mtimeMs: file.mtimeMs,
  }));
}
