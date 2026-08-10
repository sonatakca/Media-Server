import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assertMediaRootDirectory } from "./pathSecurity";
import { PlaybackSessionManager } from "../lib/playback-planner/playbackSessionManager";
import { PLAYBACK_SESSION_ROUTE_BASE } from "./ownApi/playback/playbackRoutes";
import {
  createOwnApiRequestHandler,
  isOwnApiPath,
  resolveOwnApiRequestId,
  type OwnApiLogger,
} from "./ownApi/ownApiHandler";
import { createRuntimeHealthService } from "./ownApi/runtimeHealthService";
import {
  createNativeRuntime,
  type NativeRuntime,
} from "./ownApi/nativeRuntime";

/**
 * Seyirlik's own media server.
 *
 * This process is the whole backend: identity, catalogue, artwork, playback and
 * background work all live behind `/ownAPI/v1`. It has no Jellyfin dependency
 * and no fallback to one.
 */

export interface MediaServerOptions {
  host?: string;
  port?: number;
  mediaRoot: string;
  allowedOrigins?: string[];
  publicOrigin?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  generatedStoragePath?: string;
  preferredVideoEncoder?: string;
  maxConcurrentVideoTranscodes?: number;
  softwareTranscodeThreads?: number;
  environment?: Record<string, string | undefined>;
  logger?: OwnApiLogger;
  runWorker?: boolean;
  /**
   * Directory of the built frontend. When set, this process serves the whole
   * site — the app and its API from one origin — so a browser needs no CORS
   * exception and media bytes travel straight from here rather than through a
   * proxy that would have to carry every stream.
   */
  staticRoot?: string;
}

export interface MediaServer {
  server: Server;
  host: string;
  port: number;
  mediaRoot: string;
  close(): Promise<void>;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43110;
const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.seyirlik.org",
  "https://seyirlik.org",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function parseHttpOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  return parsed.origin;
}

export function parseAllowedOrigins(
  rawOrigins: string | undefined,
  environment = process.env.NODE_ENV,
): string[] {
  if (rawOrigins === undefined) {
    // Production trusts nothing it was not told to trust.
    return environment === "production" ? [] : [...DEFAULT_ALLOWED_ORIGINS];
  }

  return Array.from(
    new Set(
      rawOrigins
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
        .map((origin) => {
          const parsed = parseHttpOrigin(origin);
          if (!parsed) {
            throw new Error(
              "SEYIRLIK_ALLOWED_ORIGINS must contain only valid HTTP(S) origins without paths.",
            );
          }
          return parsed;
        }),
    ),
  );
}

function requestOrigin(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host) return undefined;
  const protocol =
    "encrypted" in request.socket && request.socket.encrypted ? "https" : "http";
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return undefined;
  }
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: Set<string>,
  publicOrigin: string | undefined,
): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;

  const isSameOrigin =
    typeof origin === "string" &&
    origin === (publicOrigin ?? requestOrigin(request));

  if (Array.isArray(origin) || (!isSameOrigin && !allowedOrigins.has(origin))) {
    response.statusCode = 403;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        error: { code: "CORS_ORIGIN_DENIED", message: "Origin is not allowed." },
      }),
    );
    return false;
  }

  if (isSameOrigin) return true;

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Range, X-Request-Id, X-CSRF-Token",
  );
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, X-Request-Id",
  );
  return true;
}

/**
 * Serves the built frontend, falling back to index.html for client routes.
 *
 * Hashed asset filenames are immutable and cached hard; everything else must be
 * revalidated so a deploy is picked up rather than pinned by a stale cache.
 */
export function createStaticHandler(staticRoot: string) {
  const root = path.resolve(staticRoot);

  return async function serveStatic(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    if (request.method !== "GET" && request.method !== "HEAD") return false;

    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    const segments = relative.split("/").filter((segment) => segment.length > 0);

    // A traversal attempt falls through to the SPA rather than escaping the
    // build directory.
    const requested =
      segments.includes("..") || relative.includes("\0")
        ? null
        : path.join(root, ...segments);

    let filePath = requested;
    let isAppShell = false;

    if (!filePath || !(await stat(filePath).catch(() => null))?.isFile()) {
      filePath = path.join(root, "index.html");
      isAppShell = true;
    }

    const stats = await stat(filePath).catch(() => null);
    if (!stats?.isFile()) return false;

    const extension = path.extname(filePath).toLowerCase();
    response.statusCode = 200;
    response.setHeader(
      "Content-Type",
      STATIC_CONTENT_TYPES[extension] ?? "application/octet-stream",
    );
    response.setHeader("Content-Length", String(stats.size));
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Cache-Control",
      !isAppShell && segments[0] === "assets"
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );

    if (request.method === "HEAD") {
      response.end();
      return true;
    }

    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath as string);
      response.on("close", () => stream.destroy());
      stream.on("error", reject);
      stream.pipe(response).on("finish", resolve).on("error", reject);
    });
    return true;
  };
}

export async function createMediaServer(
  options: MediaServerOptions,
): Promise<MediaServer> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const mediaRoot = await assertMediaRootDirectory(options.mediaRoot);
  const generatedStoragePath = options.generatedStoragePath ?? tmpdir();

  // Generated storage belongs to Seyirlik, unlike the media root, which must
  // already exist and is never created on our behalf. Creating it here means a
  // fresh deployment reaches `ready` without an operator running mkdir first.
  await mkdir(generatedStoragePath, { recursive: true });

  const sessionManager = new PlaybackSessionManager({
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    outputRoot: generatedStoragePath,
    // Session URLs are produced by the native playback routes, so the manager
    // must build playlist links under the same versioned namespace.
    sessionRouteBase: PLAYBACK_SESSION_ROUTE_BASE,
    ...(options.preferredVideoEncoder
      ? { preferredVideoEncoder: options.preferredVideoEncoder }
      : {}),
    ...(options.maxConcurrentVideoTranscodes
      ? { maxConcurrentVideoTranscodes: options.maxConcurrentVideoTranscodes }
      : {}),
    ...(options.softwareTranscodeThreads
      ? { softwareThreads: options.softwareTranscodeThreads }
      : {}),
  });

  const configuredOrigins = new Set(
    options.allowedOrigins ?? parseAllowedOrigins(undefined),
  );

  const runtime: NativeRuntime = await createNativeRuntime({
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
    trustedOrigins: configuredOrigins,
    mediaRoot,
    sessionManager,
    generatedStoragePath,
    ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    ...(options.runWorker === undefined ? {} : { runWorker: options.runWorker }),
  });

  const healthService = createRuntimeHealthService({
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    mediaStoragePath: mediaRoot,
    generatedStoragePath: sessionManager.outputRoot ?? generatedStoragePath,
    databaseCheck: runtime.databaseCheck,
    jobsCheck: runtime.jobsCheck,
  });

  const logger = options.logger ?? console;
  const allowedOrigins = configuredOrigins;
  const publicOrigin = options.publicOrigin
    ? parseHttpOrigin(options.publicOrigin)
    : undefined;
  if (options.publicOrigin && !publicOrigin) {
    throw new Error("SEYIRLIK_PUBLIC_ORIGIN must be a valid HTTP(S) origin.");
  }

  const serveStatic = options.staticRoot
    ? createStaticHandler(options.staticRoot)
    : undefined;

  const ownApiHandler = createOwnApiRequestHandler({
    healthService,
    logger,
    routeHandlers: [runtime.routeHandler],
    routeTemplateResolver: runtime.resolveRouteTemplate,
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (isOwnApiPath(url.pathname)) {
      response.setHeader("X-Request-Id", resolveOwnApiRequestId(request));
    }

    if (!applyCors(request, response, allowedOrigins, publicOrigin)) return;

    if (await ownApiHandler(request, response)) return;

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    if (serveStatic && (await serveStatic(request, response, url.pathname))) {
      return;
    }

    // Without a built frontend, everything this process serves lives under the
    // versioned namespace.
    response.statusCode = 404;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify({
        error: { code: "NOT_FOUND", message: "Route not found." },
      }),
    );
  });

  return {
    server,
    host,
    port,
    mediaRoot,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await sessionManager.stopAllSessions();
      await runtime.close();
    },
  };
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) return DEFAULT_PORT;
  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("SEYIRLIK_PORT must be a valid TCP port.");
  }
  return parsed;
}

function parseOptionalPositiveInteger(
  rawValue: string | undefined,
  variableName: string,
): number | undefined {
  if (!rawValue) return undefined;
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${variableName} must be a positive integer.`);
  }
  return value;
}

export async function startMediaServerFromEnv(): Promise<MediaServer> {
  const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT;
  if (!mediaRoot) {
    throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
  }

  const maxVideoTranscodes = parseOptionalPositiveInteger(
    process.env.SEYIRLIK_MAX_VIDEO_TRANSCODES,
    "SEYIRLIK_MAX_VIDEO_TRANSCODES",
  );
  const softwareThreads = parseOptionalPositiveInteger(
    process.env.SEYIRLIK_SOFTWARE_TRANSCODE_THREADS,
    "SEYIRLIK_SOFTWARE_TRANSCODE_THREADS",
  );

  const server = await createMediaServer({
    host: process.env.SEYIRLIK_HOST ?? DEFAULT_HOST,
    port: parsePort(process.env.SEYIRLIK_PORT),
    mediaRoot,
    allowedOrigins: parseAllowedOrigins(process.env.SEYIRLIK_ALLOWED_ORIGINS),
    ...(process.env.SEYIRLIK_PUBLIC_ORIGIN
      ? { publicOrigin: process.env.SEYIRLIK_PUBLIC_ORIGIN }
      : {}),
    ...(process.env.SEYIRLIK_FFMPEG_PATH
      ? { ffmpegPath: process.env.SEYIRLIK_FFMPEG_PATH }
      : {}),
    ...(process.env.SEYIRLIK_FFPROBE_PATH
      ? { ffprobePath: process.env.SEYIRLIK_FFPROBE_PATH }
      : {}),
    ...(process.env.SEYIRLIK_GENERATED_STORAGE
      ? { generatedStoragePath: process.env.SEYIRLIK_GENERATED_STORAGE }
      : {}),
    ...(process.env.SEYIRLIK_STATIC_ROOT
      ? { staticRoot: process.env.SEYIRLIK_STATIC_ROOT }
      : {}),
    preferredVideoEncoder: process.env.SEYIRLIK_FFMPEG_VIDEO_ENCODER ?? "auto",
    ...(maxVideoTranscodes === undefined
      ? {}
      : { maxConcurrentVideoTranscodes: maxVideoTranscodes }),
    ...(softwareThreads === undefined
      ? {}
      : { softwareTranscodeThreads: softwareThreads }),
  });

  await new Promise<void>((resolve) => {
    server.server.listen(server.port, server.host, resolve);
  });

  console.info(
    `Seyirlik media server running at http://${server.host}:${server.port}`,
  );
  console.info(
    `Own API mounted at http://${server.host}:${server.port}/ownAPI/v1`,
  );
  console.info(`Media root: ${server.mediaRoot}`);

  const shutdown = async (signal: NodeJS.Signals) => {
    console.info(`[Seyirlik] ${signal} received; shutting down.`);
    try {
      await server.close();
      process.exit(0);
    } catch (error) {
      console.error(
        "[Seyirlik] Shutdown failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  startMediaServerFromEnv().catch((error) => {
    console.error(
      "[Seyirlik] Startup failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
