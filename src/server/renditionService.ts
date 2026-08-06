import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type {
  PlaybackMediaResolver,
  PlaybackResolvedMedia,
} from "../lib/playback-planner/playbackRoutes";
import type {
  AvailableQualityFile,
  MediaQualityManifest,
} from "../renditions/contracts";
import {
  RENDITION_PROFILE_VERSION,
  classifyQualityHeight,
} from "../renditions/policy";
import {
  loadRenditionRegistry,
  type RenditionRegistry,
} from "../renditions/registry";
import { inspectCompletedRendition } from "../renditions/validation";

// Analysis records "already-valid" when every required height already exists and
// "pending" while a title is only partially generated. Both still expose the
// heights that passed validation, so only records describing an untrustworthy
// source or output are rejected here; `inspectCompletedRendition` remains the
// authority on whether the files themselves are usable.
const REJECTED_REGISTRY_STATUSES = new Set([
  "failed",
  "stale",
  "validation-failed",
]);

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}\.mp4$/;
const MAX_ACCESS_ENTRIES = 10_000;
const ACCESS_TTL_MS = 12 * 60 * 60 * 1_000;

export interface RenditionOriginalDescriptor {
  /** Rotation-corrected display dimensions of the source video stream. */
  width: number;
  height: number;
  rotation?: number;
  codec: string;
  container?: string;
  bitrate?: number;
  fileSize?: number;
  playableUrl?: string;
}

/**
 * What the requesting browser can actually decode. HDR renditions are HEVC Main
 * 10, so a client without HEVC must never be offered one — it would be handed a
 * file it cannot play instead of falling back to the existing transcode path.
 */
export interface RenditionClientSupport {
  hevc?: boolean;
  h264?: boolean;
}

function canDecodeRendition(
  file: { videoCodec: string; hdr?: boolean },
  client: RenditionClientSupport | undefined,
): boolean {
  if (!client) return true;
  if (file.videoCodec === "hevc") return client.hevc === true;
  return client.h264 !== false;
}

interface RenditionAccessFile {
  filePath: string;
  expectedSize: number;
}

interface RenditionAccess {
  createdAt: number;
  manifest: MediaQualityManifest;
  versionRoot: string;
  filesById: Map<string, RenditionAccessFile>;
}

export interface RenditionServiceOptions {
  mediaRoot: string;
  renditionRoot: string;
  stateRoot: string;
  mediaResolver: PlaybackMediaResolver;
  basePath?: string;
}

export interface RenditionService {
  createManifest(
    media: PlaybackResolvedMedia,
    original?: RenditionOriginalDescriptor,
    client?: RenditionClientSupport,
  ): Promise<MediaQualityManifest>;
  handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean>;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

function normalizeForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = normalizeForComparison(root);
  const normalizedCandidate = normalizeForComparison(candidate);
  return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

function mediaRelativePath(
  mediaRoot: string,
  filePath: string,
): string | undefined {
  if (!isInside(mediaRoot, filePath)) return undefined;
  const relative = path.relative(mediaRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return undefined;
  return relative.split(path.sep).join("/");
}

function parseRange(
  value: string | undefined,
  fileSize: number,
): { start: number; end: number } | undefined | null {
  if (!value) return undefined;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const rawStart = match[1];
  const rawEnd = match[2];
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : fileSize - 1;
  }
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= fileSize
  ) {
    return null;
  }
  return { start, end: Math.min(end, fileSize - 1) };
}

async function streamImmutableMp4(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  expectedSize: number,
) {
  const fileStats = await stat(filePath);
  if (
    !fileStats.isFile() ||
    fileStats.size <= 0 ||
    fileStats.size !== expectedSize
  ) {
    throw new Error(
      "Generated rendition file is unavailable or no longer valid.",
    );
  }
  const range = parseRange(request.headers.range, fileStats.size);
  response.setHeader("Content-Type", "video/mp4");
  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.headers.range && range === null) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${fileStats.size}`);
    response.end();
    return;
  }
  if (range) {
    response.statusCode = 206;
    response.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${fileStats.size}`,
    );
    response.setHeader("Content-Length", range.end - range.start + 1);
  } else {
    response.statusCode = 200;
    response.setHeader("Content-Length", fileStats.size);
  }
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(filePath, range ?? undefined);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

function originalQuality(
  original: RenditionOriginalDescriptor | undefined,
): AvailableQualityFile | undefined {
  if (!original?.playableUrl) return undefined;
  // Letterboxed masters store a short frame height (a 4K scope feature is
  // 3840x1604), so the label comes from the standard quality class rather than
  // the raw pixel height.
  const qualityHeight = classifyQualityHeight(original);
  return {
    id: "original",
    label: `Original (${qualityHeight}p)`,
    kind: "original",
    width: original.width,
    height: qualityHeight,
    bitrate: original.bitrate,
    fileSize: original.fileSize,
    videoCodec: original.codec,
    container: original.container,
    playbackUrl: original.playableUrl,
  };
}

export function createRenditionService({
  mediaRoot,
  renditionRoot,
  stateRoot,
  mediaResolver,
  basePath = "/api/playback/renditions",
}: RenditionServiceOptions): RenditionService {
  const accessByToken = new Map<string, RenditionAccess>();
  const registryPath = path.join(stateRoot, "registry.json");
  let cachedRegistry:
    | { signature: string; items: RenditionRegistry["items"] }
    | undefined;

  /**
   * The registry covers the whole library, so it is re-read only when the
   * offline CLI has actually rewritten it. Playback requests otherwise reuse the
   * parsed copy instead of parsing the full inventory per request.
   */
  const loadRegistryItems = async (): Promise<RenditionRegistry["items"]> => {
    let signature = "missing";

    try {
      const registryStats = await stat(registryPath);
      signature = `${registryStats.size}:${registryStats.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (cachedRegistry?.signature === signature) {
      return cachedRegistry.items;
    }

    const { items } = await loadRenditionRegistry(registryPath);
    cachedRegistry = { signature, items };
    return items;
  };

  const pruneAccess = () => {
    const cutoff = Date.now() - ACCESS_TTL_MS;
    for (const [token, access] of accessByToken) {
      if (access.createdAt < cutoff) accessByToken.delete(token);
    }
    while (accessByToken.size > MAX_ACCESS_ENTRIES) {
      const oldest = accessByToken.keys().next().value as string | undefined;
      if (!oldest) break;
      accessByToken.delete(oldest);
    }
  };

  const createManifest: RenditionService["createManifest"] = async (
    media,
    original,
    client,
  ) => {
    const playableOriginal = originalQuality(original);
    const emptyManifest: MediaQualityManifest = {
      mediaId: media.mediaId,
      qualities: playableOriginal ? [playableOriginal] : [],
      limitations: {
        generatedAudio: "default-track-only",
        generatedSubtitles: "external-or-original-only",
        switching: "complete-file-rebuffer",
      },
    };
    const relativePath = mediaRelativePath(mediaRoot, media.filePath);
    if (!relativePath) return emptyManifest;
    const registryItems = await loadRegistryItems();
    const registryItem = registryItems.find(
      (item) => item.relativePath.toLowerCase() === relativePath.toLowerCase(),
    );
    if (
      !registryItem ||
      REJECTED_REGISTRY_STATUSES.has(registryItem.status ?? "") ||
      registryItem.profileVersion !== RENDITION_PROFILE_VERSION ||
      registryItem.size !== media.size ||
      Math.trunc(registryItem.mtimeMs) !== Math.trunc(media.mtimeMs)
    ) {
      return emptyManifest;
    }
    const inspection = await inspectCompletedRendition({
      mediaRoot: path.join(renditionRoot, registryItem.id),
      mediaId: registryItem.id,
      sourceFingerprint: registryItem.sourceFingerprint,
      profileVersion: RENDITION_PROFILE_VERSION,
    });
    if (
      inspection.status !== "ready" ||
      !inspection.versionRoot ||
      !inspection.metadata
    ) {
      return emptyManifest;
    }

    const token = mediaResolver.encodeMediaToken(media.mediaId);
    const filesById = new Map<string, RenditionAccessFile>();
    const playableFiles = inspection.metadata.files.filter((file) =>
      canDecodeRendition(file, client),
    );
    if (playableFiles.length === 0) return emptyManifest;
    const generated: AvailableQualityFile[] = playableFiles.map((file) => {
      const fileId = `${file.qualityHeight}-${registryItem.sourceFingerprint.slice(0, 12)}.mp4`;
      filesById.set(fileId, {
        filePath: file.file,
        expectedSize: file.fileSize,
      });
      return {
        id: `generated-${file.qualityHeight}`,
        label: `${file.qualityHeight}p`,
        kind: "generated" as const,
        width: file.width,
        height: file.qualityHeight,
        bitrate: file.bitrate,
        fileSize: file.fileSize,
        videoCodec: file.videoCodec,
        audioCodec: file.audioCodec,
        container: file.container,
        ...(file.hdr ? { hdr: true } : {}),
        playbackUrl: `${basePath}/${encodeURIComponent(token)}/${fileId}`,
        sourceAudioStreamIndex: file.sourceAudioStreamIndex,
        audioLanguage: file.audioLanguage,
      };
    });
    const manifest: MediaQualityManifest = {
      ...emptyManifest,
      generatedAt: inspection.metadata.createdAt,
      qualities: [
        ...generated,
        ...(playableOriginal ? [playableOriginal] : []),
      ].sort(
        (left, right) =>
          right.height - left.height ||
          Number(left.kind === "original") - Number(right.kind === "original"),
      ),
    };
    pruneAccess();
    accessByToken.set(token, {
      createdAt: Date.now(),
      manifest,
      versionRoot: inspection.versionRoot,
      filesById,
    });
    return manifest;
  };

  const handleRequest: RenditionService["handleRequest"] = async (
    request,
    response,
  ) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(`${basePath}/`)) return false;
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.setHeader("Allow", "GET, HEAD, OPTIONS");
      response.end();
      return true;
    }
    try {
      const remainder = url.pathname.slice(`${basePath}/`.length);
      const slashIndex = remainder.indexOf("/");
      if (slashIndex <= 0) throw new Error("Rendition capability is invalid.");
      const token = decodeURIComponent(remainder.slice(0, slashIndex));
      const fileId = decodeURIComponent(remainder.slice(slashIndex + 1));
      if (!TOKEN_PATTERN.test(token) || !FILE_ID_PATTERN.test(fileId)) {
        throw new Error("Rendition request is invalid.");
      }
      pruneAccess();
      const access = accessByToken.get(token);
      if (!access) {
        sendJson(response, 404, {
          error: {
            code: "RENDITION_CAPABILITY_INVALID",
            message: "Rendition access is unavailable or expired.",
          },
        });
        return true;
      }
      const registeredFile = access.filesById.get(fileId);
      if (!registeredFile) {
        sendJson(response, 404, {
          error: {
            code: "RENDITION_FILE_NOT_FOUND",
            message: "Rendition file was not found.",
          },
        });
        return true;
      }
      const candidate = path.join(access.versionRoot, registeredFile.filePath);
      const [trustedRoot, trustedFile] = await Promise.all([
        realpath(access.versionRoot),
        realpath(candidate),
      ]);
      if (!isInside(trustedRoot, trustedFile)) {
        throw new Error("Rendition file escapes the validated output root.");
      }
      await streamImmutableMp4(
        request,
        response,
        trustedFile,
        registeredFile.expectedSize,
      );
      return true;
    } catch {
      sendJson(response, 400, {
        error: {
          code: "INVALID_RENDITION_REQUEST",
          message: "Rendition request is invalid.",
        },
      });
      return true;
    }
  };

  return { createManifest, handleRequest };
}
