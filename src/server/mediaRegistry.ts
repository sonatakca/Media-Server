import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  assertMediaRootDirectory,
  isPathInsideRoot,
  resolveTrustedFileInRoot,
} from "./pathSecurity";

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
  | "MEDIA_NOT_READABLE"
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

export class MediaTokenRegistry {
  private mediaIdsByToken = new Map<string, string>();

  encodeMediaToken(mediaId: string): string {
    const token = randomUUID();

    this.mediaIdsByToken.set(token, mediaId);
    return token;
  }

  decodeMediaToken(token: string): string {
    if (!token || !TOKEN_PATTERN.test(token)) {
      throw new MediaRegistryError(
        "MEDIA_TOKEN_INVALID",
        "Media token is invalid.",
      );
    }

    const mediaId = this.mediaIdsByToken.get(token);

    if (!mediaId) {
      throw new MediaRegistryError(
        "MEDIA_TOKEN_INVALID",
        "Media token is invalid or expired.",
      );
    }

    return mediaId;
  }
}

export function createMediaTokenRegistry(): MediaTokenRegistry {
  return new MediaTokenRegistry();
}

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

async function assertMediaRoot(mediaRoot: string): Promise<string> {
  try {
    return await assertMediaRootDirectory(mediaRoot);
  } catch {
    throw new MediaRegistryError(
      "MEDIA_ID_INVALID",
      "SEYIRLIK_MEDIA_ROOT must point to an existing directory.",
    );
  }
}

export async function createMediaRegistry(
  mediaRoot: string,
): Promise<MediaRegistry> {
  const realRoot = await assertMediaRoot(mediaRoot);
  const tokenRegistry = createMediaTokenRegistry();

  return {
    mediaRoot: realRoot,
    resolveMedia: async (mediaId: string) => resolveMedia(realRoot, mediaId),
    encodeMediaToken: (mediaId: string) =>
      tokenRegistry.encodeMediaToken(mediaId),
    decodeMediaToken: (token: string) => tokenRegistry.decodeMediaToken(token),
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
  const trustedFile = await resolveTrustedFileInRoot(realRoot, candidatePath);

  if (!isPathInsideRoot(realRoot, trustedFile.filePath)) {
    throw new MediaRegistryError(
      "MEDIA_OUTSIDE_ROOT",
      "The requested media is outside the configured media root.",
      403,
    );
  }

  return {
    mediaId: relativeMediaId,
    filePath: trustedFile.filePath,
    size: trustedFile.size,
    mtimeMs: trustedFile.mtimeMs,
  };
}
