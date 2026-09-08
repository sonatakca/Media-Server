/**
 * The real filesystem, behind one authorised root.
 *
 * Every path an import touches goes through here, and every one of them is
 * proven to be inside the root the import was authorised against — not the
 * root configuration currently names, and not a root passed in at the call
 * site. There is deliberately no method that takes a root.
 *
 * Containment is checked twice, because once is not enough. The lexical check
 * refuses `..` and anything that resolves outside before a syscall happens;
 * the real check resolves links and refuses a path whose *actual* location is
 * elsewhere. Only the second catches a junction planted in the middle of a
 * download, and only the first works on a path that does not exist yet.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import type { ImportEntry, RootedReadFileSystem } from "./importSource";

export class PathEscapeError extends Error {
  readonly attempted: string;

  constructor(attempted: string) {
    super("The path is outside the root this import was authorised against.");
    this.name = "PathEscapeError";
    this.attempted = attempted;
  }
}

export interface RootResolver {
  readonly root: string;
  /**
   * Where a relative path would be, without asking the filesystem.
   *
   * Works for a path that does not exist yet, which is what a destination is
   * before it is written.
   */
  resolve(relative: string): string;
  /**
   * Where a relative path actually is, with links resolved.
   *
   * Returns null when nothing is there. Throws when what is there lives
   * outside the root.
   */
  resolveReal(relative: string): Promise<string | null>;
}

/**
 * Splits a relative path the same way on both platforms.
 *
 * Import paths are held as `/`-separated strings everywhere in this module,
 * including on Windows, so one stored destination means the same thing on
 * either host. Backslashes are treated as separators too, so a name arriving
 * from a Windows source cannot smuggle a segment past the `..` check.
 */
function segmentsOf(relative: string): string[] {
  return relative.split(/[/\\]+/).filter((segment) => segment.length > 0);
}

export function createRootResolver(root: string): RootResolver {
  const resolvedRoot = path.resolve(root);
  let realRoot: Promise<string> | undefined;

  function resolve(relative: string): string {
    if (relative.includes("\0")) {
      throw new PathEscapeError(relative);
    }
    const segments = segmentsOf(relative);
    // Checked before resolution as well as after: `resolve` would silently
    // collapse `..` into a path that then looks perfectly well-behaved.
    if (segments.includes("..")) {
      throw new PathEscapeError(relative);
    }
    const absolute = path.resolve(resolvedRoot, ...segments);
    if (
      absolute !== resolvedRoot &&
      !isPathInsideRoot(resolvedRoot, absolute)
    ) {
      throw new PathEscapeError(relative);
    }
    return absolute;
  }

  async function resolveReal(relative: string): Promise<string | null> {
    const absolute = resolve(relative);
    realRoot ??= realpath(resolvedRoot);
    let real: string;
    try {
      real = await realpath(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const trustedRoot = await realRoot;
    if (real !== trustedRoot && !isPathInsideRoot(trustedRoot, real)) {
      throw new PathEscapeError(relative);
    }
    return real;
  }

  return { root: resolvedRoot, resolve, resolveReal };
}

function toEntry(
  name: string,
  stats: {
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
  },
): ImportEntry {
  return {
    name,
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

/**
 * Reading one rooted tree.
 *
 * `lstat` throughout, never `stat`: a junction has to be visible *as* a
 * junction for the inspector to refuse it. Following it first and asking
 * afterwards is how an importer ends up walking somebody's system directory.
 */
export function createNodeReadFileSystem(root: string): RootedReadFileSystem {
  const resolver = createRootResolver(root);

  return {
    root: resolver.root,

    list: async (relative) => {
      const absolute = await resolver.resolveReal(relative);
      if (absolute === null) return [];
      const dirents = await readdir(absolute, { withFileTypes: true });
      const entries: ImportEntry[] = [];
      for (const dirent of dirents) {
        // A dirent already knows directory from link; the stat is for the
        // size and mtime that stability is judged on.
        const stats = await lstat(path.join(absolute, dirent.name)).catch(
          () => null,
        );
        if (!stats) continue;
        entries.push(toEntry(dirent.name, stats));
      }
      return entries;
    },

    stat: async (relative) => {
      const absolute = resolver.resolve(relative);
      const stats = await lstat(absolute).catch(() => null);
      if (!stats) return null;
      /*
       * A link is returned as a link rather than resolved, so the caller can
       * refuse it. Anything else must really live inside the root.
       */
      if (
        !stats.isSymbolicLink() &&
        (await resolver.resolveReal(relative)) === null
      ) {
        return null;
      }
      return toEntry(path.basename(absolute), stats);
    },
  };
}
