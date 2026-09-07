import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  compareSummaries,
  copyDirectoryTree,
  summariseDirectory,
  UnsafePathError,
  type DirectorySummary,
} from "./directoryVerification";
import {
  isInsideDirectory,
  isLegacyExternalTrickplayDirectory,
} from "./trickplayStorage";

/**
 * Taking the Jellyfin-era `*.trickplay` folders out of the media library, and
 * keeping every byte of them.
 *
 * These are not this server's trickplay and never were. They came with the
 * library, they are historical comparison material, and the operator wants them
 * out of the media volume but not gone. So the lifecycle is:
 *
 *     discover  ->  copy  ->  verify every file by SHA-256  ->  remove original
 *
 * and never a move. A rename would make the original stop existing at the
 * instant the copy appeared, which leaves nothing to fall back to if the copy
 * turns out to be short. The verification step is the reason the copy is a copy.
 *
 * Two properties this must hold, and holds by construction:
 *
 * - The managed `<titleRoot>/trickplay/` directory is never selected. The
 *   predicate is an exact `.trickplay` *suffix* test, not a substring search,
 *   because whatever this selects, it eventually deletes.
 * - Nothing is deleted whose archived copy has not been read back and compared,
 *   file by file, by content. A single mismatch anywhere in a folder keeps the
 *   whole folder.
 */

export type ArchiveStatus =
  /** Copied, verified byte for byte, original removed. */
  | "archived"
  /** The archive already held an identical copy; the original was removed. */
  | "already-archived"
  /** The archive holds something else under this name. Nothing was touched. */
  | "conflict"
  /** A symlink, or a path that escapes a root. Nothing was touched. */
  | "unsafe"
  | "failed";

export interface ArchiveOutcome {
  /** Path relative to the media root — the archive's identity for this folder. */
  relativePath: string;
  source: string;
  destination: string;
  status: ArchiveStatus;
  files: number;
  bytes: number;
  detail?: string;
}

export interface ArchivePlanEntry {
  relativePath: string;
  source: string;
  destination: string;
}

export type ArchivePhase =
  | "discovering"
  | "copying"
  | "verifying"
  | "removing"
  | "complete";

export interface ArchiveReport {
  dryRun: boolean;
  mediaRoot: string;
  archiveRoot: string;
  discovered: number;
  outcomes: ArchiveOutcome[];
  /** Files and bytes across everything discovered, whatever became of it. */
  files: number;
  bytes: number;
}

export interface LegacyArchiveOptions {
  mediaRoot: string;
  archiveRoot: string;
  dryRun?: boolean;
  /** Stops after this many directories. Useful for a first cautious run. */
  limit?: number;
  onPhase?: (phase: ArchivePhase, entry?: ArchivePlanEntry) => void;
  onOutcome?: (outcome: ArchiveOutcome) => void;
}

export class ArchiveRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveRootError";
  }
}

/**
 * The two roots must not contain one another.
 *
 * An archive inside the media root would be rediscovered by the next run and
 * archived into itself; a media root inside the archive root would make every
 * destination land on top of a source. Both are checked before a single byte
 * moves, because both turn a safe operation into a destructive one.
 */
export function assertRootsDisjoint(
  mediaRoot: string,
  archiveRoot: string,
): void {
  const media = path.resolve(mediaRoot);
  const archive = path.resolve(archiveRoot);
  if (media === archive) {
    throw new ArchiveRootError(
      "The archive root and the media root are the same directory.",
    );
  }
  if (isInsideDirectory(media, archive)) {
    throw new ArchiveRootError(
      "The archive root is inside the media root. Choose a directory outside the library.",
    );
  }
  if (isInsideDirectory(archive, media)) {
    throw new ArchiveRootError(
      "The media root is inside the archive root. Choose a directory outside the library.",
    );
  }
}

/**
 * Every legacy trickplay folder under `mediaRoot`, as media-relative paths.
 *
 * The walk does not follow symlinks and does not descend into a legacy folder
 * once it has found one — what is inside a `*.trickplay` is its contents, not
 * more candidates. The managed `trickplay/` directory is skipped explicitly
 * rather than merely failing the predicate, so a future reader can see that it
 * was considered and deliberately excluded.
 */
export async function discoverLegacyTrickplayDirectories(
  mediaRoot: string,
): Promise<string[]> {
  const root = path.resolve(mediaRoot);
  const found: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const entryPath = path.join(directory, name);
      if (!isInsideDirectory(root, entryPath)) continue;
      const stats = await lstat(entryPath).catch(() => null);
      // A symlinked directory is not walked: following one is how a walk
      // rooted in the library ends up selecting something outside it.
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) continue;
      if (isLegacyExternalTrickplayDirectory(name)) {
        found.push(path.relative(root, entryPath).split(path.sep).join("/"));
        continue;
      }
      await walk(entryPath);
    }
  }

  await walk(root);
  return found.sort();
}

/** Where one discovered folder is archived to, deterministically. */
export function archiveDestinationFor(
  archiveRoot: string,
  relativePath: string,
): string {
  return path.join(path.resolve(archiveRoot), ...relativePath.split("/"));
}

async function directoryExists(candidate: string): Promise<boolean> {
  const stats = await stat(candidate).catch(() => null);
  return stats?.isDirectory() ?? false;
}

/**
 * Archives every legacy folder found under the media root.
 *
 * A dry run reports the whole plan — what would be copied, what is already
 * archived, what conflicts, what is unsafe — and writes nothing anywhere.
 */
export async function archiveLegacyTrickplay({
  mediaRoot,
  archiveRoot,
  dryRun = false,
  limit = Infinity,
  onPhase,
  onOutcome,
}: LegacyArchiveOptions): Promise<ArchiveReport> {
  assertRootsDisjoint(mediaRoot, archiveRoot);
  const media = path.resolve(mediaRoot);
  const archive = path.resolve(archiveRoot);

  onPhase?.("discovering");
  const discovered = await discoverLegacyTrickplayDirectories(media);
  const selected = discovered.slice(0, limit === Infinity ? undefined : limit);

  const outcomes: ArchiveOutcome[] = [];
  let files = 0;
  let bytes = 0;

  for (const relativePath of selected) {
    const source = path.join(media, ...relativePath.split("/"));
    const destination = archiveDestinationFor(archive, relativePath);
    const entry: ArchivePlanEntry = { relativePath, source, destination };

    const outcome = await archiveOne(entry);
    files += outcome.files;
    bytes += outcome.bytes;
    outcomes.push(outcome);
    onOutcome?.(outcome);
  }

  onPhase?.("complete");
  return {
    dryRun,
    mediaRoot: media,
    archiveRoot: archive,
    discovered: discovered.length,
    outcomes,
    files,
    bytes,
  };

  async function archiveOne(entry: ArchivePlanEntry): Promise<ArchiveOutcome> {
    const base: ArchiveOutcome = {
      ...entry,
      status: "failed",
      files: 0,
      bytes: 0,
    };

    /*
     * Both ends re-checked here, not only at the roots. `relativePath` came
     * from a walk of the filesystem, and a check that only happened once at the
     * top would not cover the path actually about to be deleted.
     */
    if (!isInsideDirectory(media, entry.source)) {
      return {
        ...base,
        status: "unsafe",
        detail: "The source resolves outside the media root.",
      };
    }
    if (!isInsideDirectory(archive, entry.destination)) {
      return {
        ...base,
        status: "unsafe",
        detail: "The destination resolves outside the archive root.",
      };
    }
    // Belt and braces against the one mistake that would be unrecoverable: the
    // managed directory is not a legacy folder and is never archived.
    if (!isLegacyExternalTrickplayDirectory(path.basename(entry.source))) {
      return {
        ...base,
        status: "unsafe",
        detail: "The directory is not an external legacy trickplay folder.",
      };
    }
    const sourceStats = await lstat(entry.source).catch(() => null);
    if (!sourceStats?.isDirectory() || sourceStats.isSymbolicLink()) {
      return {
        ...base,
        status: "unsafe",
        detail: "The source is not a plain directory.",
      };
    }

    let sourceSummary: DirectorySummary;
    try {
      sourceSummary = await summariseDirectory(entry.source);
    } catch (error) {
      return {
        ...base,
        status: error instanceof UnsafePathError ? "unsafe" : "failed",
        detail: (error as Error).message,
      };
    }
    const counted = {
      files: sourceSummary.files.length,
      bytes: sourceSummary.totalBytes,
    };

    if (await directoryExists(entry.destination)) {
      let existing: DirectorySummary;
      try {
        existing = await summariseDirectory(entry.destination);
      } catch (error) {
        return {
          ...base,
          ...counted,
          status: "conflict",
          detail: (error as Error).message,
        };
      }
      const comparison = compareSummaries(sourceSummary, existing);
      if (!comparison.identical) {
        /*
         * The archive is never overwritten and never renamed around. A
         * destination that holds different bytes is a fact an operator has to
         * see, not a collision to be worked around with a `(2)` suffix — the
         * media-relative path *is* this folder's identity in the archive.
         */
        return {
          ...base,
          ...counted,
          status: "conflict",
          detail: `The archive already holds a different copy: ${comparison.differences
            .slice(0, 3)
            .join("; ")}`,
        };
      }
      if (dryRun) {
        return {
          ...base,
          ...counted,
          status: "already-archived",
          detail:
            "Already archived and verified; the original would be removed.",
        };
      }
      onPhase?.("removing", entry);
      await rm(entry.source, { recursive: true });
      return { ...base, ...counted, status: "already-archived" };
    }

    if (dryRun) return { ...base, ...counted, status: "archived" };

    /*
     * Copied into its final place rather than into a staging name. An
     * interrupted copy leaves a partial destination, which the next run finds,
     * compares, and reports as a conflict — and a conflict keeps the original.
     * That is the correct outcome: a half-copied archive is exactly the thing
     * nobody should delete a source for.
     */
    try {
      onPhase?.("copying", entry);
      await mkdir(path.dirname(entry.destination), { recursive: true });
      await copyDirectoryTree(entry.source, entry.destination);

      onPhase?.("verifying", entry);
      const copied = await summariseDirectory(entry.destination);
      const comparison = compareSummaries(sourceSummary, copied);
      if (!comparison.identical) {
        return {
          ...base,
          ...counted,
          status: "failed",
          detail: `The archived copy did not verify, so the original was kept: ${comparison.differences
            .slice(0, 3)
            .join("; ")}`,
        };
      }

      onPhase?.("removing", entry);
      await rm(entry.source, { recursive: true });
      return { ...base, ...counted, status: "archived" };
    } catch (error) {
      return {
        ...base,
        ...counted,
        status: error instanceof UnsafePathError ? "unsafe" : "failed",
        detail: (error as Error).message,
      };
    }
  }
}

export interface ArchiveSummaryCounts {
  discovered: number;
  archived: number;
  alreadyArchived: number;
  conflicts: number;
  unsafe: number;
  failed: number;
  files: number;
  bytes: number;
}

/** The numbers a run prints, counted from its own outcomes. */
export function summariseArchiveReport(
  report: ArchiveReport,
): ArchiveSummaryCounts {
  const count = (status: ArchiveStatus) =>
    report.outcomes.filter((outcome) => outcome.status === status).length;
  return {
    discovered: report.discovered,
    archived: count("archived"),
    alreadyArchived: count("already-archived"),
    conflicts: count("conflict"),
    unsafe: count("unsafe"),
    failed: count("failed"),
    files: report.files,
    bytes: report.bytes,
  };
}
