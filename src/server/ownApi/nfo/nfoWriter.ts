import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isPathInsideRoot } from "../../pathSecurity";
import { isManagedNfo } from "./nfoSerializer";
import type { NfoExportMode, NfoOverwritePolicy } from "./nfoConfig";
import { writesFiles } from "./nfoConfig";

/**
 * The only thing in the NFO subsystem that touches a disk.
 *
 * Two rules shape all of it. The first is that a file this exporter did not
 * write is never replaced: a legacy Jellyfin .nfo, a Radarr one, or something a
 * person typed by hand represents work that cannot be recovered from the
 * catalogue, and silently overwriting it is the one failure that would matter.
 * The second is that a partially written .nfo must never be visible, so every
 * write lands on a temporary name and is renamed into place.
 *
 * There is deliberately no delete. An .nfo that stops being planned — because a
 * title was renamed, or a version removed — is left exactly where it is.
 */

export type NfoWriteStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped-conflict"
  | "skipped-disabled"
  | "failed";

export type NfoConflictReason =
  | "foreign-file"
  | "not-a-regular-file"
  | "symlink"
  | "unsafe-path"
  | "outside-root";

export type NfoExistingState = "absent" | "managed" | "foreign" | "unreadable";

export interface NfoExistingFile {
  state: NfoExistingState;
  /** Set only when `state` is `unreadable`. */
  reason?: NfoConflictReason;
  /** The bytes on disk, when they were readable. */
  contents?: string;
}

export interface NfoWriteResult {
  status: NfoWriteStatus;
  /** Relative to the writer's root; never an absolute host path. */
  relativePath: string;
  reason?: NfoConflictReason;
  /** Safe, path-free description for a failure. */
  error?: string;
}

export interface NfoWriter {
  readonly mode: NfoExportMode;
  readonly canWrite: boolean;
  /** Absolute root files land in. For startup logging, never for a response. */
  readonly rootDescription: string;
  write(
    relativePath: string,
    xml: string,
    options?: { force?: boolean },
  ): Promise<NfoWriteResult>;
  /** What is already at this path, without writing or creating anything. */
  inspect(relativePath: string): Promise<NfoExistingFile>;
}

export interface CreateNfoWriterOptions {
  mode: NfoExportMode;
  overwritePolicy: NfoOverwritePolicy;
  /** Required for `sidecar`. */
  mediaRoot?: string;
  /** Required for `generated`; exports land in `<root>/nfo/…`. */
  generatedStoragePath?: string;
}

/** A legacy .nfo is small; anything larger is not something to compare. */
const MAX_EXISTING_BYTES = 4 * 1_024 * 1_024;

export class UnsafeNfoPathError extends Error {
  reason: NfoConflictReason;

  constructor(reason: NfoConflictReason, message: string) {
    super(message);
    this.name = "UnsafeNfoPathError";
    this.reason = reason;
  }
}

/**
 * Splits an export-root-relative path into segments, rejecting everything that
 * is not a plain descending path to an .nfo file.
 *
 * Absolute paths, drive letters, UNC prefixes, `..`, `.`, NUL and backslash
 * separators are refused rather than normalised: a path that needed normalising
 * did not come from where it claims to, and quietly repairing it is how a
 * traversal becomes a write.
 */
export function safeNfoSegments(relativePath: string): string[] {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new UnsafeNfoPathError("unsafe-path", "The path is empty.");
  }
  if (relativePath.includes("\0")) {
    throw new UnsafeNfoPathError("unsafe-path", "The path contains NUL.");
  }
  if (relativePath.includes("\\")) {
    throw new UnsafeNfoPathError(
      "unsafe-path",
      "The path uses a backslash separator.",
    );
  }
  if (
    relativePath.startsWith("/") ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath)
  ) {
    throw new UnsafeNfoPathError("unsafe-path", "The path is absolute.");
  }

  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new UnsafeNfoPathError(
        "unsafe-path",
        "The path contains an empty or relative segment.",
      );
    }
  }
  if (!relativePath.toLowerCase().endsWith(".nfo")) {
    throw new UnsafeNfoPathError(
      "unsafe-path",
      "The path is not an .nfo file.",
    );
  }
  return segments;
}

/**
 * Walks the directory chain, resolving each level through symlinks.
 *
 * Containment has to be checked against real paths, not against the string the
 * caller supplied: a title folder replaced by a link to somewhere else passes
 * any purely lexical check and would put the write outside the root entirely.
 * Once a level does not exist, nothing below it can either, so the remainder is
 * joined lexically and still checked.
 */
async function resolveContainedDirectory(
  realRoot: string,
  segments: string[],
  create: boolean,
): Promise<string> {
  let current = realRoot;
  let existsSoFar = true;

  for (const segment of segments) {
    const candidate = path.join(current, segment);
    if (!isPathInsideRoot(realRoot, candidate)) {
      throw new UnsafeNfoPathError(
        "outside-root",
        "The path escapes the export root.",
      );
    }

    if (!existsSoFar) {
      current = candidate;
      continue;
    }

    let resolved = await realpath(candidate).catch(() => null);
    if (resolved === null) {
      if (!create) {
        existsSoFar = false;
        current = candidate;
        continue;
      }
      await mkdir(candidate, { recursive: true });
      resolved = await realpath(candidate);
    }
    if (!isPathInsideRoot(realRoot, resolved)) {
      throw new UnsafeNfoPathError(
        "outside-root",
        "A directory on the path links outside the export root.",
      );
    }
    current = resolved;
  }

  return current;
}

export function createNfoWriter({
  mode,
  overwritePolicy,
  mediaRoot,
  generatedStoragePath,
}: CreateNfoWriterOptions): NfoWriter {
  const canWrite = writesFiles(mode);

  /*
   * The root is resolved for every mode, not only the writing ones.
   *
   * `preview` and `disabled` never write, but they do have to answer "what is
   * already at this path" — a preview that reported every legacy Jellyfin file
   * as absent would hide the one thing an operator is previewing to find out.
   * The media root is what it inspects, because that is where an .nfo actually
   * matters to another program, whichever mode eventually produces it.
   */
  let configuredRoot: string | undefined;
  if (mode === "sidecar") {
    if (!mediaRoot) {
      throw new Error("Sidecar NFO export needs SEYIRLIK_MEDIA_ROOT.");
    }
    configuredRoot = path.resolve(mediaRoot);
  } else if (mode === "generated") {
    if (!generatedStoragePath) {
      throw new Error("Generated NFO export needs SEYIRLIK_GENERATED_STORAGE.");
    }
    configuredRoot = path.join(path.resolve(generatedStoragePath), "nfo");
  } else if (mediaRoot) {
    configuredRoot = path.resolve(mediaRoot);
  } else if (generatedStoragePath) {
    configuredRoot = path.join(path.resolve(generatedStoragePath), "nfo");
  }

  /**
   * Resolves the target and reads whatever is already there.
   *
   * The existing file is examined with `lstat` first, so a symlink is seen as a
   * symlink rather than followed into whatever it points at — which is how a
   * "harmless" sidecar write becomes a write to /etc.
   */
  async function locate(
    relativePath: string,
    create: boolean,
  ): Promise<{ absolutePath: string; existing: NfoExistingFile }> {
    const segments = safeNfoSegments(relativePath);
    const fileName = segments[segments.length - 1] as string;

    const root = configuredRoot as string;
    if (create) await mkdir(root, { recursive: true });
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot === null) {
      throw new UnsafeNfoPathError(
        "outside-root",
        "The export root does not exist.",
      );
    }

    const directory = await resolveContainedDirectory(
      realRoot,
      segments.slice(0, -1),
      create,
    );
    const absolutePath = path.join(directory, fileName);
    if (!isPathInsideRoot(realRoot, absolutePath)) {
      throw new UnsafeNfoPathError(
        "outside-root",
        "The path escapes the export root.",
      );
    }

    const stats = await lstat(absolutePath).catch(() => null);
    if (!stats) return { absolutePath, existing: { state: "absent" } };
    if (stats.isSymbolicLink()) {
      return {
        absolutePath,
        existing: { state: "unreadable", reason: "symlink" },
      };
    }
    if (!stats.isFile()) {
      return {
        absolutePath,
        existing: { state: "unreadable", reason: "not-a-regular-file" },
      };
    }
    // Something this large is not an .nfo anyone wrote by hand; it is treated
    // as foreign rather than read into memory to compare.
    if (stats.size > MAX_EXISTING_BYTES) {
      return { absolutePath, existing: { state: "foreign" } };
    }

    const contents = await readFile(absolutePath, "utf8").catch(() => null);
    if (contents === null) {
      return {
        absolutePath,
        existing: { state: "unreadable", reason: "not-a-regular-file" },
      };
    }
    return {
      absolutePath,
      existing: {
        state: isManagedNfo(contents) ? "managed" : "foreign",
        contents,
      },
    };
  }

  async function writeAtomically(
    absolutePath: string,
    xml: string,
  ): Promise<void> {
    // A unique name per attempt: two workers exporting the same title must not
    // share a temporary file, or one truncates the other's bytes mid-write.
    const temporaryPath = `${absolutePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporaryPath, xml, { encoding: "utf8", mode: 0o644 });
    try {
      await rename(temporaryPath, absolutePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  return {
    mode,
    canWrite,
    rootDescription: canWrite
      ? (configuredRoot as string)
      : `${configuredRoot ?? "(none)"} (inspected only; nothing is written)`,

    inspect: async (relativePath) => {
      // No root at all means nothing can be reported; that is only reachable
      // when neither a media root nor generated storage was configured.
      if (!configuredRoot) return { state: "absent" };
      try {
        const { existing } = await locate(relativePath, false);
        return existing;
      } catch (error) {
        if (error instanceof UnsafeNfoPathError) {
          return { state: "unreadable", reason: error.reason };
        }
        return { state: "unreadable", reason: "not-a-regular-file" };
      }
    },

    write: async (relativePath, xml, options = {}) => {
      if (!canWrite) {
        return { status: "skipped-disabled", relativePath };
      }

      let absolutePath: string;
      let existing: NfoExistingFile;
      try {
        const located = await locate(relativePath, true);
        absolutePath = located.absolutePath;
        existing = located.existing;
      } catch (error) {
        if (error instanceof UnsafeNfoPathError) {
          return {
            status: "skipped-conflict",
            relativePath,
            reason: error.reason,
          };
        }
        return {
          status: "failed",
          relativePath,
          error: "The export path could not be resolved.",
        };
      }

      if (existing.state === "unreadable") {
        return {
          status: "skipped-conflict",
          relativePath,
          ...(existing.reason ? { reason: existing.reason } : {}),
        };
      }

      // Byte-identical output is the whole reason an unchanged title costs
      // nothing: no write, no mtime change, and no library automation
      // downstream noticing a file that did not actually change.
      if (existing.contents !== undefined && existing.contents === xml) {
        return { status: "unchanged", relativePath };
      }

      const force = options.force === true || overwritePolicy === "force";
      if (existing.state === "foreign" && !force) {
        return {
          status: "skipped-conflict",
          relativePath,
          reason: "foreign-file",
        };
      }

      try {
        await writeAtomically(absolutePath, xml);
      } catch {
        return {
          status: "failed",
          relativePath,
          error: "The file could not be written.",
        };
      }

      return {
        status: existing.state === "absent" ? "created" : "updated",
        relativePath,
      };
    },
  };
}
