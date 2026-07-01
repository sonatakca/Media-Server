import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decidePlaybackPlan } from "./playbackDecision";
import type { PlaybackSessionManager } from "./playbackSessionManager";
import type {
  ClientCapabilities,
  MediaAnalysis,
  PlaybackPlan,
  PlaybackQualityLimit,
} from "./types";

export interface PlaybackResolvedMedia {
  mediaId: string;
  filePath: string;
  size: number;
  mtimeMs: number;
}

export interface PlaybackMediaResolver {
  resolveMedia(mediaId: string): Promise<PlaybackResolvedMedia>;
  encodeMediaToken(mediaId: string): string;
  decodeMediaToken(token: string): string;
}

export interface PlaybackMediaStore {
  getMediaAnalysis(media: PlaybackResolvedMedia): Promise<MediaAnalysis>;
  saveClientCapabilities?(
    capabilities: ClientCapabilities,
  ): Promise<void> | void;
}

export interface PlaybackRouteDependencies {
  mediaStore: PlaybackMediaStore;
  mediaResolver: PlaybackMediaResolver;
  sessionManager: PlaybackSessionManager;
  basePath?: string;
  maxJsonBodyBytes?: number;
}

interface PlaybackRequestBody {
  mediaId?: unknown;
  clientCapabilities?: unknown;
  selectedVideoStreamIndex?: unknown;
  selectedAudioStreamIndex?: unknown;
  selectedSubtitleStreamIndex?: unknown;
  forceQualityLimit?: unknown;
}

interface ValidatedPlaybackRequestBody {
  mediaId: string;
  clientCapabilities: ClientCapabilities;
  selectedVideoStreamIndex?: number;
  selectedAudioStreamIndex?: number;
  selectedSubtitleStreamIndex?: number | null;
  forceQualityLimit?: PlaybackQualityLimit;
}

type ErrorStatusCode = 400 | 403 | 404 | 405 | 409 | 413 | 500 | 502 | 503;

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024;
const VALID_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VALID_SEGMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const ALLOWED_HLS_EXTENSIONS = new Set([".m3u8", ".m4s", ".mp4", ".ts"]);

class PlaybackRouteError extends Error {
  code: string;
  statusCode: ErrorStatusCode;

  constructor(code: string, message: string, statusCode: ErrorStatusCode) {
    super(message);
    this.name = "PlaybackRouteError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendRouteError(response: ServerResponse, error: unknown): void {
  const maybeError = error as Partial<PlaybackRouteError> | undefined;
  const statusCode =
    typeof maybeError?.statusCode === "number" ? maybeError.statusCode : 500;
  const code =
    typeof maybeError?.code === "string"
      ? maybeError.code
      : "INTERNAL_SERVER_ERROR";
  const message =
    error instanceof Error && statusCode !== 500
      ? error.message
      : statusCode === 500
        ? "An internal playback error occurred."
        : "Playback request failed.";

  sendJson(response, statusCode, {
    error: {
      code,
      message,
    },
  });
}

function sendMethodNotAllowed(
  response: ServerResponse,
  allowedMethods: string[],
): void {
  response.statusCode = 405;
  response.setHeader("Allow", allowedMethods.join(", "));
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify({
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "HTTP method is not allowed for this route.",
      },
    }),
  );
}

function safeDecodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PlaybackRouteError(
      "INVALID_URL_ENCODING",
      "Request URL encoding is invalid.",
      400,
    );
  }
}

function parseJsonBody<TBody>(
  request: IncomingMessage,
  maxBytes: number,
): Promise<TBody> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    request.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }

      totalBytes += chunk.byteLength;

      if (totalBytes > maxBytes) {
        rejected = true;
        reject(
          new PlaybackRouteError(
            "REQUEST_BODY_TOO_LARGE",
            "Request body is too large.",
            413,
          ),
        );
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (rejected) {
        return;
      }

      const raw = Buffer.concat(chunks).toString("utf8");

      if (!raw.trim()) {
        resolveBody({} as TBody);
        return;
      }

      try {
        resolveBody(JSON.parse(raw) as TBody);
      } catch {
        reject(
          new PlaybackRouteError(
            "INVALID_JSON",
            "Request body must be valid JSON.",
            400,
          ),
        );
      }
    });
  });
}

function getContentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".mp4":
    case ".m4v":
    case ".mov":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".m3u8":
      return "application/vnd.apple.mpegurl";
    case ".m4s":
      return "video/iso.segment";
    case ".ts":
      return "video/mp2t";
    case ".vtt":
      return "text/vtt; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function safeSessionFile(outputDir: string, fileName: string): string | null {
  if (
    !VALID_SEGMENT_NAME.test(fileName) ||
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    !ALLOWED_HLS_EXTENSIONS.has(extname(fileName).toLowerCase())
  ) {
    return null;
  }

  const resolvedOutputDir = resolve(outputDir);
  const resolvedFile = resolve(join(resolvedOutputDir, fileName));

  if (
    resolvedFile !== resolvedOutputDir &&
    !resolvedFile.startsWith(`${resolvedOutputDir}${sep}`)
  ) {
    return null;
  }

  return resolvedFile;
}

function parseRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number,
): { start: number; end: number } | null {
  if (!rangeHeader) {
    return null;
  }

  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);

  if (!match) {
    return null;
  }

  const [, rawStart, rawEnd] = match;
  let start = rawStart ? Number(rawStart) : NaN;
  let end = rawEnd ? Number(rawEnd) : NaN;

  if (!rawStart && rawEnd) {
    const suffixLength = Number(rawEnd);

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }

    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    if (!Number.isFinite(start)) {
      return null;
    }

    if (!Number.isFinite(end)) {
      end = fileSize - 1;
    }
  }

  if (start < 0 || end < start || start >= fileSize) {
    return null;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1),
  };
}

async function streamFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
): Promise<void> {
  const stats = await stat(filePath);
  const range = parseRangeHeader(request.headers.range, stats.size);

  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", getContentType(filePath));

  if (request.headers.range && !range) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${stats.size}`);
    response.end();
    return;
  }

  if (range) {
    response.statusCode = 206;
    response.setHeader(
      "Content-Range",
      `bytes ${range.start}-${range.end}/${stats.size}`,
    );
    response.setHeader("Content-Length", range.end - range.start + 1);

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(filePath, range)
      .on("error", () => {
        if (!response.destroyed) {
          response.destroy();
        }
      })
      .pipe(response);
    return;
  }

  response.statusCode = 200;
  response.setHeader("Content-Length", stats.size);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(filePath)
    .on("error", () => {
      if (!response.destroyed) {
        response.destroy();
      }
    })
    .pipe(response);
}

async function waitForFile(
  filePath: string,
  sessionProcessExited: () => boolean,
): Promise<"ready" | "process-exited" | "timeout"> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await access(filePath);
      return "ready";
    } catch {
      if (sessionProcessExited()) {
        return "process-exited";
      }

      await delay(150);
    }
  }

  return "timeout";
}

function assertObject(value: unknown, code: string, message: string): object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PlaybackRouteError(code, message, 400);
  }

  return value;
}

function validateOptionalNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PlaybackRouteError(
      "INVALID_PLAYBACK_REQUEST",
      `${fieldName} must be a non-negative integer.`,
      400,
    );
  }

  return value;
}

function validatePlaybackRequestBody(
  body: PlaybackRequestBody,
): ValidatedPlaybackRequestBody {
  assertObject(body, "INVALID_PLAYBACK_REQUEST", "Request body is required.");

  if (typeof body.mediaId !== "string" || !body.mediaId.trim()) {
    throw new PlaybackRouteError(
      "INVALID_PLAYBACK_REQUEST",
      "mediaId is required.",
      400,
    );
  }

  const clientCapabilities = assertObject(
    body.clientCapabilities,
    "INVALID_PLAYBACK_REQUEST",
    "clientCapabilities is required.",
  ) as ClientCapabilities;
  const forceQualityLimit =
    body.forceQualityLimit === undefined || body.forceQualityLimit === null
      ? undefined
      : (assertObject(
          body.forceQualityLimit,
          "INVALID_PLAYBACK_REQUEST",
          "forceQualityLimit must be an object.",
        ) as PlaybackQualityLimit);

  return {
    mediaId: body.mediaId,
    clientCapabilities,
    selectedVideoStreamIndex: validateOptionalNumber(
      body.selectedVideoStreamIndex,
      "selectedVideoStreamIndex",
    ),
    selectedAudioStreamIndex: validateOptionalNumber(
      body.selectedAudioStreamIndex,
      "selectedAudioStreamIndex",
    ),
    selectedSubtitleStreamIndex:
      body.selectedSubtitleStreamIndex === null
        ? null
        : validateOptionalNumber(
            body.selectedSubtitleStreamIndex,
            "selectedSubtitleStreamIndex",
          ),
    forceQualityLimit,
  };
}

function withDirectDelivery(
  plan: PlaybackPlan,
  dependencies: PlaybackRouteDependencies,
  mediaId: string,
): PlaybackPlan {
  const basePath = dependencies.basePath ?? "/api/playback";
  const token = dependencies.mediaResolver.encodeMediaToken(mediaId);

  return {
    ...plan,
    delivery: {
      type: "file",
      url: `${basePath}/direct/${token}`,
    },
  };
}

async function handlePlaybackRequest(
  body: PlaybackRequestBody,
  dependencies: PlaybackRouteDependencies,
): Promise<PlaybackPlan> {
  const validBody = validatePlaybackRequestBody(body);
  const resolvedMedia = await dependencies.mediaResolver.resolveMedia(
    validBody.mediaId,
  );
  const media = await dependencies.mediaStore.getMediaAnalysis(resolvedMedia);

  await dependencies.mediaStore.saveClientCapabilities?.(
    validBody.clientCapabilities,
  );

  const plan = decidePlaybackPlan({
    media,
    client: validBody.clientCapabilities,
    selectedVideoStreamIndex: validBody.selectedVideoStreamIndex,
    selectedAudioStreamIndex: validBody.selectedAudioStreamIndex,
    selectedSubtitleStreamIndex: validBody.selectedSubtitleStreamIndex,
    forceQualityLimit: validBody.forceQualityLimit,
  });

  if (!plan.requiresFfmpeg) {
    return withDirectDelivery(plan, dependencies, resolvedMedia.mediaId);
  }

  const session = await dependencies.sessionManager.createSession(plan, media);
  return session.plan;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: PlaybackRouteDependencies,
): Promise<boolean> {
  const basePath = dependencies.basePath ?? "/api/playback";
  const maxJsonBodyBytes =
    dependencies.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith(basePath)) {
    return false;
  }

  try {
    if (pathname === `${basePath}/capabilities`) {
      if (request.method !== "POST") {
        sendMethodNotAllowed(response, ["POST", "OPTIONS"]);
        return true;
      }

      const capabilities = await parseJsonBody<ClientCapabilities>(
        request,
        maxJsonBodyBytes,
      );

      await dependencies.mediaStore.saveClientCapabilities?.(capabilities);
      sendJson(response, 200, { ok: true });
      return true;
    }

    if (pathname === `${basePath}/request`) {
      if (request.method !== "POST") {
        sendMethodNotAllowed(response, ["POST", "OPTIONS"]);
        return true;
      }

      const body = await parseJsonBody<PlaybackRequestBody>(
        request,
        maxJsonBodyBytes,
      );
      const payload = await handlePlaybackRequest(body, dependencies);

      sendJson(response, 200, payload);
      return true;
    }

    if (pathname.startsWith(`${basePath}/direct/`)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendMethodNotAllowed(response, ["GET", "HEAD", "OPTIONS"]);
        return true;
      }

      const rawToken = pathname.slice(`${basePath}/direct/`.length);

      if (!rawToken || rawToken.includes("/")) {
        throw new PlaybackRouteError(
          "MEDIA_TOKEN_INVALID",
          "Media token is invalid.",
          400,
        );
      }

      const mediaToken = safeDecodePathComponent(rawToken);
      const mediaId = dependencies.mediaResolver.decodeMediaToken(mediaToken);
      const resolvedMedia =
        await dependencies.mediaResolver.resolveMedia(mediaId);

      await streamFile(request, response, resolvedMedia.filePath);
      return true;
    }

    if (pathname.startsWith(`${basePath}/sessions/`)) {
      const parts = pathname
        .slice(`${basePath}/sessions/`.length)
        .split("/")
        .filter(Boolean)
        .map(safeDecodePathComponent);
      const [sessionId, fileName, action] = parts;

      if (parts.length > 3 || !sessionId || !VALID_SESSION_ID.test(sessionId)) {
        throw new PlaybackRouteError(
          "INVALID_SESSION_ID",
          "Playback session id is invalid.",
          400,
        );
      }

      if (action === "stop") {
        throw new PlaybackRouteError(
          "INVALID_HLS_FILENAME",
          "HLS filename is invalid.",
          400,
        );
      }

      if (fileName === "stop") {
        if (request.method !== "POST") {
          sendMethodNotAllowed(response, ["POST", "OPTIONS"]);
          return true;
        }

        const existed = Boolean(
          dependencies.sessionManager.getSession(sessionId),
        );

        await dependencies.sessionManager.stopSession(sessionId);
        sendJson(response, 200, { ok: true, stopped: existed });
        return true;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendMethodNotAllowed(response, ["GET", "HEAD", "OPTIONS"]);
        return true;
      }

      const session = dependencies.sessionManager.getSession(sessionId);

      if (!session) {
        throw new PlaybackRouteError(
          "PLAYBACK_SESSION_NOT_FOUND",
          "Playback session was not found.",
          404,
        );
      }

      const requestedFile = fileName || "master.m3u8";
      const safeFile = safeSessionFile(session.outputDir, requestedFile);

      if (!safeFile) {
        throw new PlaybackRouteError(
          "INVALID_HLS_FILENAME",
          "HLS filename is invalid.",
          400,
        );
      }

      dependencies.sessionManager.touchSession(sessionId);

      const fileStatus = await waitForFile(
        safeFile,
        () => session.process.exitCode !== null,
      );

      if (fileStatus !== "ready") {
        throw new PlaybackRouteError(
          fileStatus === "process-exited"
            ? "FFMPEG_STARTUP_FAILED"
            : "HLS_NOT_READY",
          fileStatus === "process-exited"
            ? "FFmpeg exited before the requested HLS file was ready."
            : "HLS output is not ready yet.",
          fileStatus === "process-exited" ? 409 : 404,
        );
      }

      await streamFile(request, response, safeFile);
      return true;
    }

    return false;
  } catch (error) {
    sendRouteError(response, error);
    return true;
  }
}

export function createPlaybackRequestHandler(
  dependencies: PlaybackRouteDependencies,
): (request: IncomingMessage, response: ServerResponse) => Promise<boolean> {
  return (request, response) => routeRequest(request, response, dependencies);
}
