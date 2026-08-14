import { createHash } from "node:crypto";
import {
  buildSortTitle,
  isBookFile,
  isExtraDirectory,
  isIgnoredEntry,
  isSampleFile,
  isSubtitleFile,
  isTrailerFile,
  isVideoFile,
  parseEpisodeName,
  parseMovieName,
  parseSeasonFolder,
  parseSubtitleSuffix,
  splitExtension,
} from "./nameParser";

export type LibraryKind =
  | "movies"
  | "series"
  | "books"
  | "collections"
  | "mixed";

export interface ScanDirectoryEntry {
  name: string;
  isDirectory: boolean;
}

/**
 * Filesystem seam. Every path is relative to the media root and uses forward
 * slashes, so a scan can be exercised entirely in memory and no absolute host
 * path ever enters the scan result.
 */
export interface ScannerFileSystem {
  readDirectory(relativePath: string): Promise<ScanDirectoryEntry[]>;
  statFile(relativePath: string): Promise<{ size: number; mtimeMs: number }>;
}

export interface ScannedSubtitle {
  relativePath: string;
  codec: string;
  isText: boolean;
  language?: string;
  isForced: boolean;
  isDefault: boolean;
}

export interface ScannedFile {
  relativePath: string;
  container: string;
  size: number;
  mtimeMs: number;
  fingerprint: string;
}

export type ScannedItemKind =
  | "movie"
  | "series"
  | "season"
  | "episode"
  | "book"
  | "trailer";

export interface ScannedItem {
  /** Location-derived stable identity; survives re-encodes and retitling. */
  sourceKey: string;
  kind: ScannedItemKind;
  title: string;
  sortTitle: string;
  year?: number;
  indexNumber?: number;
  parentIndexNumber?: number;
  endIndexNumber?: number;
  parentSourceKey?: string;
  seriesSourceKey?: string;
  files: ScannedFile[];
  subtitles: ScannedSubtitle[];
}

export interface ScanSkip {
  relativePath: string;
  reason: "unsupported-extension" | "sample" | "unreadable" | "depth-limit";
}

export interface ScanResult {
  items: ScannedItem[];
  skipped: ScanSkip[];
}

const MAX_SCAN_DEPTH = 12;

function joinRelative(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function buildFingerprint(
  relativePath: string,
  size: number,
  mtimeMs: number,
): string {
  return createHash("sha256")
    .update(relativePath)
    .update("\0")
    .update(String(size))
    .update("\0")
    .update(String(Math.trunc(mtimeMs)))
    .digest("hex")
    .slice(0, 32);
}

function sourceKey(kind: string, ...parts: Array<string | number>): string {
  return `${kind}:${parts.map((part) => String(part).toLowerCase()).join(":")}`;
}

async function toScannedFile(
  fs: ScannerFileSystem,
  relativePath: string,
  skipped: ScanSkip[],
): Promise<ScannedFile | null> {
  try {
    const stat = await fs.statFile(relativePath);
    return {
      relativePath,
      container: splitExtension(relativePath).extension,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      fingerprint: buildFingerprint(relativePath, stat.size, stat.mtimeMs),
    };
  } catch {
    skipped.push({ relativePath, reason: "unreadable" });
    return null;
  }
}

interface DirectoryContents {
  directories: string[];
  videoFiles: string[];
  bookFiles: string[];
  subtitleFiles: string[];
}

async function readDirectoryContents(
  fs: ScannerFileSystem,
  relativePath: string,
  skipped: ScanSkip[],
): Promise<DirectoryContents> {
  const contents: DirectoryContents = {
    directories: [],
    videoFiles: [],
    bookFiles: [],
    subtitleFiles: [],
  };

  let entries: ScanDirectoryEntry[];
  try {
    entries = await fs.readDirectory(relativePath);
  } catch {
    skipped.push({ relativePath, reason: "unreadable" });
    return contents;
  }

  for (const entry of entries) {
    if (isIgnoredEntry(entry.name)) continue;

    if (entry.isDirectory) {
      contents.directories.push(entry.name);
      continue;
    }

    const { stem } = splitExtension(entry.name);
    if (isSampleFile(stem)) {
      skipped.push({
        relativePath: joinRelative(relativePath, entry.name),
        reason: "sample",
      });
      continue;
    }

    if (isVideoFile(entry.name)) contents.videoFiles.push(entry.name);
    else if (isBookFile(entry.name)) contents.bookFiles.push(entry.name);
    else if (isSubtitleFile(entry.name))
      contents.subtitleFiles.push(entry.name);
    else {
      skipped.push({
        relativePath: joinRelative(relativePath, entry.name),
        reason: "unsupported-extension",
      });
    }
  }

  contents.directories.sort();
  contents.videoFiles.sort();
  contents.bookFiles.sort();
  contents.subtitleFiles.sort();
  return contents;
}

function matchSubtitles(
  directory: string,
  subtitleFiles: string[],
  videoStem: string,
): ScannedSubtitle[] {
  const matches: ScannedSubtitle[] = [];

  for (const subtitleFile of subtitleFiles) {
    const { stem, extension } = splitExtension(subtitleFile);
    const parsed = parseSubtitleSuffix(stem);
    if (parsed.baseStem.toLowerCase() !== videoStem.toLowerCase()) continue;

    const format =
      extension === "srt"
        ? { codec: "subrip", isText: true }
        : extension === "vtt"
          ? { codec: "webvtt", isText: true }
          : extension === "ass" || extension === "ssa"
            ? { codec: extension, isText: true }
            : extension === "sup"
              ? { codec: "hdmv_pgs_subtitle", isText: false }
              : { codec: extension, isText: true };

    matches.push({
      relativePath: joinRelative(directory, subtitleFile),
      codec: format.codec,
      isText: format.isText,
      ...(parsed.language === undefined ? {} : { language: parsed.language }),
      isForced: parsed.isForced,
      isDefault: parsed.isDefault,
    });
  }

  return matches;
}

/**
 * A folder holding several videos for the same title (a 4K cut plus a 1080p
 * cut, or a two-disc rip) is one logical movie with several files. Distinct
 * titles in one folder are only treated as separate movies when the folder is
 * a container rather than a title folder — that decision is made by the caller.
 */
function buildMovieItem(
  keyPath: string,
  displayName: string,
  files: ScannedFile[],
  subtitles: ScannedSubtitle[],
): ScannedItem {
  const parsed = parseMovieName(displayName);
  return {
    sourceKey: sourceKey("movie", keyPath),
    kind: "movie",
    title: parsed.title,
    sortTitle: buildSortTitle(parsed.title),
    ...(parsed.year === undefined ? {} : { year: parsed.year }),
    // Largest file first: the primary source should be the best available cut.
    files: [...files].sort((left, right) => right.size - left.size),
    subtitles,
  };
}

async function scanMovieDirectory(
  fs: ScannerFileSystem,
  directory: string,
  depth: number,
  result: ScanResult,
  isLibraryRoot: boolean,
  recurseIntoSubdirectories = true,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    result.skipped.push({ relativePath: directory, reason: "depth-limit" });
    return;
  }

  const contents = await readDirectoryContents(fs, directory, result.skipped);
  const trailerNames: string[] = [];
  const featureNames: string[] = [];

  for (const videoFile of contents.videoFiles) {
    const { stem } = splitExtension(videoFile);
    if (isTrailerFile(stem)) trailerNames.push(videoFile);
    else featureNames.push(videoFile);
  }

  if (featureNames.length > 0) {
    // Several files in one title folder are alternate cuts of the same movie —
    // but only when they parse to the same title. A folder holding "Movie A"
    // and "Movie B" is a container, not a title, and must not collapse into one
    // item.
    const distinctTitles = new Set(
      featureNames.map((name) =>
        parseMovieName(splitExtension(name).stem).title.toLowerCase(),
      ),
    );
    const isTitleFolder = !isLibraryRoot && distinctTitles.size <= 1;

    const groups = isTitleFolder
      ? [
          {
            keyPath: directory,
            displayName: directory.split("/").pop() ?? directory,
            names: featureNames,
          },
        ]
      : featureNames.map((name) => ({
          keyPath: joinRelative(directory, splitExtension(name).stem),
          displayName: splitExtension(name).stem,
          names: [name],
        }));

    for (const group of groups) {
      const files: ScannedFile[] = [];
      const subtitles: ScannedSubtitle[] = [];

      for (const name of group.names) {
        const file = await toScannedFile(
          fs,
          joinRelative(directory, name),
          result.skipped,
        );
        if (!file) continue;
        files.push(file);
        subtitles.push(
          ...matchSubtitles(
            directory,
            contents.subtitleFiles,
            splitExtension(name).stem,
          ),
        );
      }

      if (files.length === 0) continue;
      const movie = buildMovieItem(
        group.keyPath,
        group.displayName,
        files,
        subtitles,
      );
      result.items.push(movie);

      for (const trailerName of trailerNames) {
        const trailerFile = await toScannedFile(
          fs,
          joinRelative(directory, trailerName),
          result.skipped,
        );
        if (!trailerFile) continue;
        result.items.push({
          sourceKey: sourceKey("trailer", trailerFile.relativePath),
          kind: "trailer",
          title: `${movie.title} (Trailer)`,
          sortTitle: buildSortTitle(movie.title),
          parentSourceKey: movie.sourceKey,
          files: [trailerFile],
          subtitles: [],
        });
      }
      // Trailers belong to the first group only; a root-level loose-file layout
      // has no folder-scoped trailer to share.
      trailerNames.length = 0;
    }
  }

  if (!recurseIntoSubdirectories) return;

  for (const child of contents.directories) {
    if (isExtraDirectory(child)) continue;
    await scanMovieDirectory(
      fs,
      joinRelative(directory, child),
      depth + 1,
      result,
      false,
    );
  }
}

async function scanEpisodeFiles(
  fs: ScannerFileSystem,
  directory: string,
  contents: DirectoryContents,
  context: {
    seriesKey: string;
    seriesTitle: string;
    folderSeasonNumber?: number;
  },
  result: ScanResult,
  seasonKeys: Map<number, ScannedItem>,
): Promise<void> {
  for (const videoFile of contents.videoFiles) {
    const { stem } = splitExtension(videoFile);
    if (isTrailerFile(stem)) continue;

    const parsed = parseEpisodeName(stem, {
      ...(context.folderSeasonNumber === undefined
        ? {}
        : { folderSeasonNumber: context.folderSeasonNumber }),
      folderSeriesTitle: context.seriesTitle,
    });

    const file = await toScannedFile(
      fs,
      joinRelative(directory, videoFile),
      result.skipped,
    );
    if (!file) continue;

    // Without a season the episode cannot be placed in the hierarchy; season 1
    // is the conventional default for a flat series folder.
    const seasonNumber = parsed.seasonNumber ?? 1;
    let season = seasonKeys.get(seasonNumber);
    if (!season) {
      season = {
        sourceKey: sourceKey("season", context.seriesKey, seasonNumber),
        kind: "season",
        title: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
        sortTitle: String(seasonNumber).padStart(4, "0"),
        indexNumber: seasonNumber,
        parentSourceKey: context.seriesKey,
        seriesSourceKey: context.seriesKey,
        files: [],
        subtitles: [],
      };
      seasonKeys.set(seasonNumber, season);
      result.items.push(season);
    }

    const episodeNumber = parsed.episodeNumber;
    const episodeKey =
      episodeNumber === undefined
        ? sourceKey("episode", context.seriesKey, file.relativePath)
        : sourceKey("episode", context.seriesKey, seasonNumber, episodeNumber);

    const existing = result.items.find(
      (item) => item.kind === "episode" && item.sourceKey === episodeKey,
    );
    if (existing) {
      // A second file for the same episode is an alternate cut, not a duplicate.
      existing.files.push(file);
      existing.files.sort((left, right) => right.size - left.size);
      existing.subtitles.push(
        ...matchSubtitles(directory, contents.subtitleFiles, stem),
      );
      continue;
    }

    result.items.push({
      sourceKey: episodeKey,
      kind: "episode",
      title: parsed.title,
      sortTitle: `${String(seasonNumber).padStart(4, "0")}-${String(
        episodeNumber ?? 0,
      ).padStart(5, "0")}`,
      ...(episodeNumber === undefined ? {} : { indexNumber: episodeNumber }),
      parentIndexNumber: seasonNumber,
      ...(parsed.endEpisodeNumber === undefined
        ? {}
        : { endIndexNumber: parsed.endEpisodeNumber }),
      parentSourceKey: season.sourceKey,
      seriesSourceKey: context.seriesKey,
      files: [file],
      subtitles: matchSubtitles(directory, contents.subtitleFiles, stem),
    });
  }
}

async function scanSeriesFolder(
  fs: ScannerFileSystem,
  directory: string,
  result: ScanResult,
): Promise<void> {
  const folderName = directory.split("/").pop() ?? directory;
  const parsed = parseMovieName(folderName);
  const seriesKey = sourceKey("series", directory);

  const series: ScannedItem = {
    sourceKey: seriesKey,
    kind: "series",
    title: parsed.title,
    sortTitle: buildSortTitle(parsed.title),
    ...(parsed.year === undefined ? {} : { year: parsed.year }),
    files: [],
    subtitles: [],
  };
  result.items.push(series);

  const seasonKeys = new Map<number, ScannedItem>();
  const rootContents = await readDirectoryContents(
    fs,
    directory,
    result.skipped,
  );

  // Episodes sitting directly in the series folder (flat layout).
  await scanEpisodeFiles(
    fs,
    directory,
    rootContents,
    { seriesKey, seriesTitle: parsed.title },
    result,
    seasonKeys,
  );

  for (const child of rootContents.directories) {
    if (isExtraDirectory(child)) continue;

    const childPath = joinRelative(directory, child);
    const seasonNumber = parseSeasonFolder(child);
    const childContents = await readDirectoryContents(
      fs,
      childPath,
      result.skipped,
    );

    await scanEpisodeFiles(
      fs,
      childPath,
      childContents,
      {
        seriesKey,
        seriesTitle: parsed.title,
        ...(seasonNumber === undefined
          ? {}
          : { folderSeasonNumber: seasonNumber }),
      },
      result,
      seasonKeys,
    );
  }

  // A series folder that yielded nothing playable is not a series.
  const hasEpisodes = result.items.some(
    (item) => item.kind === "episode" && item.seriesSourceKey === seriesKey,
  );
  if (!hasEpisodes) {
    result.items = result.items.filter(
      (item) =>
        item.sourceKey !== seriesKey && item.seriesSourceKey !== seriesKey,
    );
  }
}

async function scanBooksDirectory(
  fs: ScannerFileSystem,
  directory: string,
  depth: number,
  result: ScanResult,
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    result.skipped.push({ relativePath: directory, reason: "depth-limit" });
    return;
  }

  const contents = await readDirectoryContents(fs, directory, result.skipped);

  for (const bookFile of contents.bookFiles) {
    const relativePath = joinRelative(directory, bookFile);
    const file = await toScannedFile(fs, relativePath, result.skipped);
    if (!file) continue;

    const parsed = parseMovieName(splitExtension(bookFile).stem);
    result.items.push({
      sourceKey: sourceKey("book", relativePath),
      kind: "book",
      title: parsed.title,
      sortTitle: buildSortTitle(parsed.title),
      ...(parsed.year === undefined ? {} : { year: parsed.year }),
      files: [file],
      subtitles: [],
    });
  }

  for (const child of contents.directories) {
    await scanBooksDirectory(
      fs,
      joinRelative(directory, child),
      depth + 1,
      result,
    );
  }
}

export interface ScanLibraryOptions {
  fileSystem: ScannerFileSystem;
  /** Library root, relative to the media root. */
  rootPath: string;
  kind: LibraryKind;
}

export async function scanLibraryTree({
  fileSystem,
  rootPath,
  kind,
}: ScanLibraryOptions): Promise<ScanResult> {
  const result: ScanResult = { items: [], skipped: [] };
  const normalizedRoot = rootPath.replace(/^\/+|\/+$/g, "");

  if (kind === "books") {
    await scanBooksDirectory(fileSystem, normalizedRoot, 0, result);
    return result;
  }

  if (kind === "series") {
    const contents = await readDirectoryContents(
      fileSystem,
      normalizedRoot,
      result.skipped,
    );
    for (const child of contents.directories) {
      if (isExtraDirectory(child)) continue;
      await scanSeriesFolder(
        fileSystem,
        joinRelative(normalizedRoot, child),
        result,
      );
    }
    return result;
  }

  if (kind === "mixed") {
    // A mixed root is scanned as movies; series folders are recognized by the
    // presence of season folders inside them.
    const contents = await readDirectoryContents(
      fileSystem,
      normalizedRoot,
      result.skipped,
    );
    for (const child of contents.directories) {
      if (isExtraDirectory(child)) continue;
      const childPath = joinRelative(normalizedRoot, child);
      const childContents = await readDirectoryContents(
        fileSystem,
        childPath,
        result.skipped,
      );
      const looksLikeSeries = childContents.directories.some(
        (grandchild) => parseSeasonFolder(grandchild) !== undefined,
      );
      if (looksLikeSeries) {
        await scanSeriesFolder(fileSystem, childPath, result);
      } else {
        await scanMovieDirectory(fileSystem, childPath, 1, result, false);
      }
    }
    // Loose files at the mixed root are movies; subdirectories were already
    // classified above, so this pass must not recurse into them again.
    await scanMovieDirectory(
      fileSystem,
      normalizedRoot,
      0,
      result,
      true,
      false,
    );
    return result;
  }

  await scanMovieDirectory(fileSystem, normalizedRoot, 0, result, true);
  return result;
}
