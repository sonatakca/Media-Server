import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { isFilesystemSidecar, isInsideDirectory } from "./trickplayStorage";

/**
 * Proving that a copy is the same as its original, before the original is
 * deleted.
 *
 * Both jobs that use this end with an irreversible step — the legacy archive
 * removes a folder from the media volume, the storage migration removes a set
 * from the old tree — and in both the only thing standing between "moved" and
 * "lost" is whether the destination really holds the same bytes. So the
 * comparison is content, not metadata: every regular file's relative path, its
 * size, and its SHA-256. A file count and a byte total can match while a file
 * is silently truncated and another silently doubled.
 */

export interface FileSummary {
  /** POSIX-style path relative to the directory that was summarised. */
  relativePath: string;
  size: number;
  sha256: string;
}

export interface DirectorySummary {
  files: FileSummary[];
  /** Relative paths of directories, so an empty one still has to be present. */
  directories: string[];
  totalBytes: number;
}

/**
 * A path that cannot be summarised or copied safely.
 *
 * Symlinks are the reason this class exists. A symlink inside a source tree
 * makes a copy either duplicate somebody else's data or point back out of the
 * archive; a symlink inside a destination tree makes a write land outside the
 * root that was checked. Neither has any business inside a folder of JPEGs, so
 * both are refused rather than resolved.
 */
export class UnsafePathError extends Error {
  constructor(
    readonly unsafePath: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsafePathError";
  }
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

/**
 * Every regular file beneath `root`, hashed, with directories recorded too.
 *
 * `lstat` throughout, never `stat`: the question is what the entry *is*, and
 * following a link would answer a question about something else.
 */
export async function summariseDirectory(
  root: string,
): Promise<DirectorySummary> {
  const files: FileSummary[] = [];
  const directories: string[] = [];
  let totalBytes = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory);
    for (const name of entries.sort()) {
      const entryPath = path.join(directory, name);
      if (!isInsideDirectory(root, entryPath)) {
        throw new UnsafePathError(
          entryPath,
          "An entry resolved outside the directory being read.",
        );
      }
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw new UnsafePathError(
          entryPath,
          "A symbolic link cannot be archived or verified.",
        );
      }
      const relativePath = toPosix(path.relative(root, entryPath));
      if (stats.isDirectory()) {
        directories.push(relativePath);
        await walk(entryPath);
        continue;
      }
      if (!stats.isFile()) {
        throw new UnsafePathError(
          entryPath,
          "Only regular files and directories can be archived.",
        );
      }
      files.push({
        relativePath,
        size: stats.size,
        sha256: await sha256OfFile(entryPath),
      });
      totalBytes += stats.size;
    }
  }

  await walk(root);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  directories.sort();
  return { files, directories, totalBytes };
}

export interface SummaryComparison {
  identical: boolean;
  /** One sentence per difference, the first few of which are worth printing. */
  differences: string[];
}

/**
 * Compares two summaries and says exactly how they differ.
 *
 * "Not identical" is not an adequate answer for an operator about to decide
 * whether a hundred gigabytes may be deleted, so every difference is named:
 * missing, extra, wrong size, wrong content.
 */
export function compareSummaries(
  source: DirectorySummary,
  destination: DirectorySummary,
): SummaryComparison {
  const differences: string[] = [];
  const destinationFiles = new Map(
    destination.files.map((file) => [file.relativePath, file]),
  );

  for (const file of source.files) {
    const other = destinationFiles.get(file.relativePath);
    if (!other) {
      differences.push(`missing in destination: ${file.relativePath}`);
      continue;
    }
    destinationFiles.delete(file.relativePath);
    if (other.size !== file.size) {
      differences.push(
        `size differs: ${file.relativePath} (${file.size} vs ${other.size})`,
      );
      continue;
    }
    if (other.sha256 !== file.sha256) {
      differences.push(`content differs: ${file.relativePath}`);
    }
  }
  for (const extra of destinationFiles.keys()) {
    differences.push(`not in source: ${extra}`);
  }

  const sourceDirectories = new Set(source.directories);
  for (const directory of destination.directories) {
    if (!sourceDirectories.has(directory)) {
      differences.push(`not in source: ${directory}/`);
    }
  }
  for (const directory of source.directories) {
    if (!destination.directories.includes(directory)) {
      differences.push(`missing in destination: ${directory}/`);
    }
  }

  return { identical: differences.length === 0, differences };
}

/**
 * The order a directory's entries have to be written in: everything the server
 * wrote first, and the sidecars the filesystem keeps for them last.
 *
 * This is not tidiness, it is the difference between a copy that verifies and
 * one that does not. On the exFAT volume this library lives on there is nowhere
 * to store an extended attribute, so macOS materialises one as an AppleDouble
 * file beside its owner: `sprite_0.jpg` has a `._sprite_0.jpg`, and a directory
 * `foo` has a `._foo`. Writing the owner rewrites the sidecar. Copy in plain
 * sorted order and `._sprite_0.jpg` goes first, `sprite_0.jpg` goes second and
 * silently overwrites the sidecar that was just placed — after which the
 * destination holds the destination's own metadata rather than the source's,
 * every AppleDouble file compares unequal, and a migration that copied
 * perfectly good sheets refuses to finish. That is exactly what happened on the
 * first run against the real library: thirty sets copied, thirty sets failed
 * verification on `._` files alone, thirty old directories rightly kept.
 *
 * Deferring the sidecars puts the explicit copy last, so the bytes that survive
 * are the ones that were read from the source. Directories are payload for this
 * purpose and are recursed into before their own `._` twin is written, because
 * creating the directory is what makes the twin appear.
 *
 * The alternative — excluding `._` files from the copy and from the comparison
 * — was rejected. Both callers exist to prove that a destination holds
 * everything the source held before the source is deleted, and a verification
 * that skips a class of files is not that proof.
 */
export function copyOrder(names: readonly string[]): string[] {
  const payloads: string[] = [];
  const sidecars: string[] = [];
  for (const name of [...names].sort()) {
    if (isFilesystemSidecar(name)) sidecars.push(name);
    else payloads.push(name);
  }
  return [...payloads, ...sidecars];
}

/**
 * Copies a tree, refusing anything that is not a plain file or directory.
 *
 * Deliberately a copy rather than a rename even when both sides are on one
 * volume: a rename removes the original at the instant the destination appears,
 * which leaves no window in which the copy can be verified while the original
 * is still there. That window is the whole point.
 */
export async function copyDirectoryTree(
  from: string,
  to: string,
): Promise<void> {
  await mkdir(to, { recursive: true });
  const entries = await readdir(from);
  for (const name of copyOrder(entries)) {
    const source = path.join(from, name);
    const destination = path.join(to, name);
    if (!isInsideDirectory(to, destination)) {
      throw new UnsafePathError(
        destination,
        "A copy destination resolved outside its root.",
      );
    }
    const stats = await lstat(source);
    if (stats.isSymbolicLink()) {
      throw new UnsafePathError(
        source,
        "A symbolic link cannot be archived or verified.",
      );
    }
    if (stats.isDirectory()) {
      await copyDirectoryTree(source, destination);
      continue;
    }
    if (!stats.isFile()) {
      throw new UnsafePathError(
        source,
        "Only regular files and directories can be archived.",
      );
    }
    await copyFile(source, destination);
  }
}
