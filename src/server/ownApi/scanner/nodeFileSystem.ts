import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import type { ScanDirectoryEntry, ScannerFileSystem } from "./libraryScan";
import type { OrganizerFileSystem } from "./organizeLibrary";

/**
 * Path containment, shared by everything that touches the media volume.
 *
 * Every path handed to these adapters is relative and re-checked for
 * containment after resolution, so a symlink pointing outside the media root
 * cannot pull foreign directories into the catalogue — or, for the organiser,
 * be moved into or out of.
 */
function createRootResolver(mediaRoot: string) {
  const root = path.resolve(mediaRoot);
  let realRoot: Promise<string> | undefined;

  function resolveRealRoot(): Promise<string> {
    realRoot ??= realpath(root);
    return realRoot;
  }

  function resolveInsideRoot(relativePath: string): string {
    if (relativePath.includes("\0")) {
      throw new Error("Path contains a NUL byte.");
    }
    const segments = relativePath.split("/").filter((s) => s.length > 0);
    if (segments.includes("..")) {
      throw new Error("Path escapes the media root.");
    }
    const resolved = path.resolve(root, ...segments);
    if (!isPathInsideRoot(root, resolved)) {
      throw new Error("Path escapes the media root.");
    }
    return resolved;
  }

  async function resolveExistingInsideRoot(
    relativePath: string,
  ): Promise<string> {
    const absolute = resolveInsideRoot(relativePath);
    const [trustedRoot, existingPath] = await Promise.all([
      resolveRealRoot(),
      realpath(absolute),
    ]);
    if (!isPathInsideRoot(trustedRoot, existingPath)) {
      throw new Error("Path escapes the media root.");
    }
    return existingPath;
  }

  return { root, resolveInsideRoot, resolveExistingInsideRoot };
}

/** Real-filesystem adapter for the scanner. Read-only, by construction. */
export function createNodeScannerFileSystem(
  mediaRoot: string,
): ScannerFileSystem {
  const { root, resolveInsideRoot, resolveExistingInsideRoot } =
    createRootResolver(mediaRoot);

  return {
    readDirectory: async (relativePath): Promise<ScanDirectoryEntry[]> => {
      const absolute = resolveInsideRoot(relativePath);
      const entries = await readdir(absolute, { withFileTypes: true });
      const results: ScanDirectoryEntry[] = [];

      for (const entry of entries) {
        if (entry.isFile()) {
          results.push({ name: entry.name, isDirectory: false });
          continue;
        }
        if (entry.isDirectory()) {
          results.push({ name: entry.name, isDirectory: true });
          continue;
        }
        if (!entry.isSymbolicLink()) continue;

        // Follow a symlink only when its target stays inside the media root.
        const linkPath = path.join(absolute, entry.name);
        try {
          const target = await stat(linkPath);
          const realTarget = await realpath(linkPath);
          if (!isPathInsideRoot(root, realTarget)) continue;
          results.push({ name: entry.name, isDirectory: target.isDirectory() });
        } catch {
          // A broken or unreadable link is simply not catalogued.
        }
      }

      return results;
    },

    readTextFile: async (relativePath) => {
      const absolute = await resolveExistingInsideRoot(relativePath);
      return readFile(absolute, "utf8");
    },

    statFile: async (relativePath) => {
      const absolute = await resolveExistingInsideRoot(relativePath);
      const stats = await stat(absolute);
      if (!stats.isFile()) {
        throw new Error("Path is not a regular file.");
      }
      return { size: stats.size, mtimeMs: stats.mtimeMs };
    },
  };
}

/**
 * Real-filesystem adapter for the organiser: the one that moves a person's
 * files.
 *
 * Three things are deliberate. A move is a `rename`, so it is atomic and costs
 * nothing however large the file — a copy would risk half a source on a full
 * disk. The destination is checked first, because `rename` replaces silently
 * and this must never be the thing that loses an original. And both ends are
 * resolved inside the media root, so neither a crafted name nor a symlinked
 * folder can move a file out of the library.
 */
export function createNodeOrganizerFileSystem(
  mediaRoot: string,
): OrganizerFileSystem {
  const { root, resolveInsideRoot } = createRootResolver(mediaRoot);

  return {
    readDirectory: async (relativePath): Promise<ScanDirectoryEntry[]> => {
      const absolute = resolveInsideRoot(relativePath);
      const entries = await readdir(absolute, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    },

    createDirectory: async (relativePath) => {
      const absolute = resolveInsideRoot(relativePath);
      await mkdir(absolute, { recursive: true });
      // A pre-existing symlinked directory would put later moves outside the
      // root; resolving it after creation is what catches that.
      const real = await realpath(absolute);
      if (!isPathInsideRoot(root, real)) {
        throw new Error("Path escapes the media root.");
      }
    },

    move: async (from, to) => {
      const source = resolveInsideRoot(from);
      const destination = resolveInsideRoot(to);
      const [realSource, realDestinationParent] = await Promise.all([
        realpath(source),
        realpath(path.dirname(destination)),
      ]);
      if (
        !isPathInsideRoot(root, realSource) ||
        !isPathInsideRoot(root, realDestinationParent)
      ) {
        throw new Error("Path escapes the media root.");
      }

      const existing = await lstat(destination).catch(() => null);
      if (existing) {
        throw new Error("Something is already at the destination.");
      }
      await rename(realSource, destination);
    },
  };
}
