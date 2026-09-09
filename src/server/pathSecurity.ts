import { constants } from "node:fs";
import { access, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export type TrustedPathErrorCode =
  | "MEDIA_ROOT_INVALID"
  | "MEDIA_LIBRARY_UNREADABLE"
  | "MEDIA_OUTSIDE_ROOT"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_NOT_FILE"
  | "MEDIA_NOT_READABLE";

export class TrustedPathError extends Error {
  code: TrustedPathErrorCode;
  statusCode: number;

  constructor(code: TrustedPathErrorCode, message: string, statusCode: number) {
    super(message);
    this.name = "TrustedPathError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface PathModuleLike {
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  isAbsolute(filePath: string): boolean;
}

export interface PathContainmentOptions {
  pathModule?: PathModuleLike;
  caseInsensitive?: boolean;
}

export interface TrustedMediaFile {
  filePath: string;
  size: number;
  mtimeMs: number;
}

function shouldCompareCaseInsensitive(
  pathModule: PathModuleLike,
  caseInsensitive: boolean | undefined,
): boolean {
  if (caseInsensitive !== undefined) {
    return caseInsensitive;
  }

  return (
    pathModule === path.win32 ||
    (pathModule === path && process.platform === "win32")
  );
}

export function isPathInsideRoot(
  realRoot: string,
  realFile: string,
  options: PathContainmentOptions = {},
): boolean {
  const pathModule = options.pathModule ?? path;
  const caseInsensitive = shouldCompareCaseInsensitive(
    pathModule,
    options.caseInsensitive,
  );
  const resolvedRoot = pathModule.resolve(realRoot);
  const resolvedFile = pathModule.resolve(realFile);
  const comparableRoot = caseInsensitive
    ? resolvedRoot.toLocaleLowerCase("en-US")
    : resolvedRoot;
  const comparableFile = caseInsensitive
    ? resolvedFile.toLocaleLowerCase("en-US")
    : resolvedFile;
  const relativePath = pathModule.relative(comparableRoot, comparableFile);

  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !pathModule.isAbsolute(relativePath)
  );
}

export interface AssertMediaRootOptions {
  /**
   * Called immediately before each syscall, with its name.
   *
   * This function is two blocking calls against a volume that may be an
   * external disk, and on the day one stopped answering the process sat inside
   * the first of them for over nine minutes with nothing to say. Naming the
   * call as it is entered is what lets startup report `stat` rather than
   * "checking storage", and it is the difference between a diagnosis and a
   * debugger session on a live process.
   */
  onOperation?: (operation: "stat" | "realpath" | "opendir") => void;
  /**
   * Library directories, relative to the media root, that must be readable.
   *
   * Seyirlik's own libraries only. Empty by default so callers that are merely
   * resolving a path — rather than deciding whether storage is usable — keep
   * the cheap check they had.
   */
  requiredLibraryRoots?: readonly string[];
}

export async function assertMediaRootDirectory(
  mediaRoot: string,
  { onOperation, requiredLibraryRoots = [] }: AssertMediaRootOptions = {},
): Promise<string> {
  const resolvedRoot = path.resolve(mediaRoot);
  onOperation?.("stat");
  const rootStat = await stat(resolvedRoot).catch(() => null);

  if (!rootStat?.isDirectory()) {
    throw new TrustedPathError(
      "MEDIA_ROOT_INVALID",
      "SEYIRLIK_MEDIA_ROOT must point to an existing media directory.",
      400,
    );
  }

  /*
   * The media root answering is not the same as the library being readable,
   * and treating them as one thing let a failing disk read as healthy for
   * hours. `D:\media` kept answering `stat` — plausibly from cached directory
   * metadata — while `Movies`, `Series` and every other child returned
   * "I/O device error" on ten attempts out of ten. Startup reported
   * `mediaStorage=available` and `ready=true` throughout.
   *
   * So each configured library root is opened and one entry is read from it.
   * Opening a directory is what fails on a volume in that state, and reading a
   * single entry is bounded whether the folder holds seven titles or seven
   * thousand — this runs on a poll and must never become a directory walk.
   *
   * Only Seyirlik's own libraries are checked. A library it does not own —
   * Books, which Jellyfin serves — is not listed here, because failing this
   * server's readiness on a directory it never reads would be a false alarm.
   */
  for (const relative of requiredLibraryRoots) {
    const libraryPath = path.resolve(resolvedRoot, relative);
    onOperation?.("opendir");
    let directory;
    try {
      directory = await opendir(libraryPath);
    } catch (error) {
      throw new TrustedPathError(
        "MEDIA_LIBRARY_UNREADABLE",
        `The library directory ${relative} could not be opened: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        503,
      );
    }
    try {
      // An empty library is readable; the read is what exercises the volume.
      await directory.read();
    } catch (error) {
      throw new TrustedPathError(
        "MEDIA_LIBRARY_UNREADABLE",
        `The library directory ${relative} could not be read: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        503,
      );
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  onOperation?.("realpath");
  return realpath(resolvedRoot);
}

export async function resolveTrustedFileInRoot(
  realMediaRoot: string,
  candidatePath: string,
): Promise<TrustedMediaFile> {
  let realFile: string;

  try {
    realFile = await realpath(candidatePath);
  } catch {
    throw new TrustedPathError(
      "MEDIA_NOT_FOUND",
      "The requested media could not be found.",
      404,
    );
  }

  if (!isPathInsideRoot(realMediaRoot, realFile)) {
    throw new TrustedPathError(
      "MEDIA_OUTSIDE_ROOT",
      "The requested media is outside the configured media root.",
      403,
    );
  }

  const mediaStat = await stat(realFile);

  if (!mediaStat.isFile()) {
    throw new TrustedPathError(
      "MEDIA_NOT_FILE",
      "The requested media is not a regular file.",
      400,
    );
  }

  try {
    await access(realFile, constants.R_OK);
  } catch {
    throw new TrustedPathError(
      "MEDIA_NOT_READABLE",
      "The requested media is not readable by the backend.",
      403,
    );
  }

  return {
    filePath: realFile,
    size: mediaStat.size,
    mtimeMs: mediaStat.mtimeMs,
  };
}
