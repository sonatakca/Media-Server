import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isEligibleVideoPath, isExcludedDirectoryName } from "./policy";

export interface DiscoveredVideoFile {
  filePath: string;
  relativePath: string;
  library: string;
  size: number;
  mtimeMs: number;
}

export interface MediaDiscoveryOptions {
  onError?: (filePath: string, error: unknown) => void;
}

function normalizedForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const comparableRoot = normalizedForComparison(root);
  const comparableCandidate = normalizedForComparison(candidate);
  const prefix = comparableRoot.endsWith(path.sep)
    ? comparableRoot
    : `${comparableRoot}${path.sep}`;
  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(prefix)
  );
}

function toPortableRelativePath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

export async function discoverEligibleVideoFiles(
  mediaRoot: string,
  options: MediaDiscoveryOptions = {},
): Promise<DiscoveredVideoFile[]> {
  const trustedRoot = await realpath(mediaRoot);
  const rootStats = await stat(trustedRoot);
  if (!rootStats.isDirectory()) {
    throw new Error("Configured media root is not a directory.");
  }

  const files: DiscoveredVideoFile[] = [];
  const visit = async (directoryPath: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      options.onError?.(directoryPath, error);
      return;
    }

    for (const entry of entries) {
      const candidatePath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (isExcludedDirectoryName(entry.name)) continue;
        try {
          const trustedDirectory = await realpath(candidatePath);
          if (!isInsideRoot(trustedRoot, trustedDirectory)) continue;
          await visit(trustedDirectory);
        } catch (error) {
          options.onError?.(candidatePath, error);
        }
        continue;
      }

      if (!entry.isFile() || !isEligibleVideoPath(candidatePath, trustedRoot)) {
        continue;
      }

      try {
        const trustedFile = await realpath(candidatePath);
        if (!isInsideRoot(trustedRoot, trustedFile)) continue;
        const fileStats = await stat(trustedFile);
        if (!fileStats.isFile()) continue;
        const relativePath = toPortableRelativePath(trustedRoot, trustedFile);
        const library = relativePath.split("/", 1)[0] || "Other";
        files.push({
          filePath: trustedFile,
          relativePath,
          library,
          size: fileStats.size,
          mtimeMs: fileStats.mtimeMs,
        });
      } catch (error) {
        options.onError?.(candidatePath, error);
      }
    }
  };

  await visit(trustedRoot);
  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en", {
      numeric: true,
      sensitivity: "base",
    }),
  );
}
