import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface ResolvedMedia {
  mediaId: string;
  filePath: string;
  size: number;
  mtimeMs: number;
}

export type MediaRegistryErrorCode =
  | "MEDIA_ID_REQUIRED"
  | "MEDIA_ID_INVALID"
  | "MEDIA_OUTSIDE_ROOT"
  | "MEDIA_NOT_FOUND"
  | "MEDIA_NOT_FILE"
  | "MEDIA_TOKEN_INVALID";

export class MediaRegistryError extends Error {
  code: MediaRegistryErrorCode;
  statusCode: number;

  constructor(
    code: MediaRegistryErrorCode,
    message: string,
    statusCode = code === "MEDIA_NOT_FOUND" ? 404 : 400,
  ) {
    super(message);
    this.name = "MediaRegistryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface MediaRegistry {
  mediaRoot: string;
  resolveMedia(mediaId: string): Promise<ResolvedMedia>;
  encodeMediaToken(mediaId: string): string;
  decodeMediaToken(token: string): string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const WINDOWS_ABSOLUTE_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/;

function toRouteRelativePath(mediaId: string): string {
  if (mediaId.includes("\0")) {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "Media identifiers cannot contain NUL bytes.",
    );
  }

  if (mediaId.includes("\\")) {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "Media identifiers must use URL-style forward slashes.",
    );
  }

  if (
    path.posix.isAbsolute(mediaId) ||
    WINDOWS_ABSOLUTE_PATTERN.test(mediaId)
  ) {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "Absolute media identifiers are not allowed.",
    );
  }

  let decodedMediaId = mediaId;

  try {
    decodedMediaId = decodeURIComponent(mediaId);
  } catch {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "Media identifier URL encoding is invalid.",
    );
  }

  const decodedSegments = decodedMediaId.split("/");

  if (
    decodedMediaId.includes("\0") ||
    decodedMediaId.includes("\\") ||
    path.posix.isAbsolute(decodedMediaId) ||
    WINDOWS_ABSOLUTE_PATTERN.test(decodedMediaId) ||
    decodedSegments.includes("..")
  ) {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "Encoded traversal or absolute media identifiers are not allowed.",
    );
  }

  const normalized = path.posix.normalize(mediaId);
  const segments = normalized.split("/");

  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    segments.includes("..") ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "Media identifier must be a relative file path inside the media root.",
    );
  }

  return normalized;
}

function isInsideRoot(realRoot: string, realFile: string): boolean {
  const relativePath = path.relative(realRoot, realFile);

  return (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
  );
}

async function assertMediaRoot(mediaRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(mediaRoot);
  const rootStat = await stat(resolvedRoot).catch(() => null);

  if (!rootStat?.isDirectory()) {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "SEYIRLIK_MEDIA_ROOT must point to an existing directory.",
    );
  }

  return realpath(resolvedRoot);
}

export function encodeMediaToken(mediaId: string): string {
  return Buffer.from(mediaId, "utf8").toString("base64url");
}

export function decodeMediaToken(token: string): string {
  if (!token || !TOKEN_PATTERN.test(token)) {
    throw new MediaRegistryError(
      "MEDIA_TOKEN_INVALID",
      "Media token is invalid.",
    );
  }

  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");

    if (!decoded || encodeMediaToken(decoded) !== token) {
      throw new Error("Token round trip failed.");
    }

    return decoded;
  } catch {
    throw new MediaRegistryError(
      "MEDIA_TOKEN_INVALID",
      "Media token is invalid.",
    );
  }
}

export async function createMediaRegistry(
  mediaRoot: string,
): Promise<MediaRegistry> {
  const realRoot = await assertMediaRoot(mediaRoot);

  return {
    mediaRoot: realRoot,
    resolveMedia: async (mediaId: string) => resolveMedia(realRoot, mediaId),
    encodeMediaToken,
    decodeMediaToken,
  };
}

export async function resolveMedia(
  mediaRoot: string,
  mediaId: string,
): Promise<ResolvedMedia> {
  if (!mediaId || !mediaId.trim()) {
    throw new MediaRegistryError(
      "MEDIA_ID_REQUIRED",
      "Media identifier is required.",
    );
  }

  const realRoot = await assertMediaRoot(mediaRoot);
  const relativeMediaId = toRouteRelativePath(mediaId.trim());
  const candidatePath = path.resolve(realRoot, ...relativeMediaId.split("/"));
  let realFile: string;

  try {
    realFile = await realpath(candidatePath);
  } catch {
    throw new MediaRegistryError(
      "MEDIA_NOT_FOUND",
      "The requested media could not be found.",
      404,
    );
  }

  if (!isInsideRoot(realRoot, realFile)) {
    throw new MediaRegistryError(
      "MEDIA_OUTSIDE_ROOT",
      "The requested media is outside the configured media root.",
      403,
    );
  }

  const mediaStat = await stat(realFile);

  if (!mediaStat.isFile()) {
    throw new MediaRegistryError(
      "MEDIA_NOT_FILE",
      "The requested media is not a regular file.",
    );
  }

  return {
    // TODO: Production should map opaque database item IDs to files instead of
    // treating media IDs as relative paths under SEYIRLIK_MEDIA_ROOT.
    mediaId: relativeMediaId,
    filePath: realFile,
    size: mediaStat.size,
    mtimeMs: mediaStat.mtimeMs,
  };
}
