import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import type { ScanDirectoryEntry, ScannerFileSystem } from "./libraryScan";

/**
 * Real-filesystem adapter for the scanner.
 *
 * Every path handed to it is relative and re-checked for containment after
 * resolution, so a symlink pointing outside the media root cannot pull foreign
 * directories into the catalogue.
 */
export function createNodeScannerFileSystem(
  mediaRoot: string,
): ScannerFileSystem {
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
