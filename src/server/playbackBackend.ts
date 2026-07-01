import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryAnalysisCache } from "./analysisCache";
import { createJellyfinMediaResolver } from "./jellyfinMediaResolver";
import { createMediaRegistry, type MediaRegistry } from "./mediaRegistry";
import { assertMediaRootDirectory } from "./pathSecurity";
import {
  createPlaybackRequestHandler,
  type PlaybackMediaResolver,
  type PlaybackMediaStore,
} from "../lib/playback-planner/playbackRoutes";
import { PlaybackSessionManager } from "../lib/playback-planner/playbackSessionManager";
import { createTmdbArtworkRequestHandler } from "./tmdbArtwork";

export interface PlaybackBackendOptions {
  host?: string;
  port?: number;
  mediaRoot?: string;
  allowedOrigins?: string[];
  cleanupIntervalMs?: number;
  mediaResolver?: PlaybackMediaResolver & { mediaRoot?: string };
  mediaRegistry?: MediaRegistry;
  mediaStore?: PlaybackMediaStore;
  sessionManager?: PlaybackSessionManager;
  tmdbApiKey?: string;
  jellyfinServerUrl?: string;
  jellyfinApiKey?: string;
  fetchImpl?: typeof fetch;
  ffmpegPath?: string;
  preferredVideoEncoder?: string;
  maxConcurrentVideoTranscodes?: number;
  softwareTranscodeThreads?: number;
}

export interface PlaybackBackend {
  server: Server;
  host: string;
  port: number;
  mediaRoot: string;
  sessionManager: PlaybackSessionManager;
  close(): Promise<void>;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 43110;
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function parseAllowedOrigins(rawOrigins: string | undefined): string[] {
  const extraOrigins =
    rawOrigins
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? [];

  return Array.from(new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]));
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: Set<string>,
): boolean {
  const origin = request.headers.origin;

  if (!origin) {
    return true;
  }

  if (Array.isArray(origin) || !allowedOrigins.has(origin)) {
    sendJson(response, 403, {
      error: {
        code: "CORS_ORIGIN_DENIED",
        message: "Origin is not allowed.",
      },
    });
    return false;
  }

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Range, Authorization",
  );
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges",
  );
  return true;
}

async function assertConfiguredMediaRoot(mediaRoot: string): Promise<string> {
  return assertMediaRootDirectory(mediaRoot);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export async function createPlaybackBackend(
  options: PlaybackBackendOptions = {},
): Promise<PlaybackBackend> {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const providedResolver = options.mediaResolver ?? options.mediaRegistry;
  const configuredMediaRoot = providedResolver?.mediaRoot
    ? providedResolver.mediaRoot
    : options.mediaRoot
      ? await assertConfiguredMediaRoot(options.mediaRoot)
      : (() => {
          throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
        })();
  const mediaResolver =
    providedResolver ?? (await createMediaRegistry(configuredMediaRoot));
  const analysisCache = new InMemoryAnalysisCache();
  const mediaStore: PlaybackMediaStore =
    options.mediaStore ??
    ({
      getMediaAnalysis: (media) => analysisCache.getOrAnalyse(media),
      saveClientCapabilities: () => undefined,
    } satisfies PlaybackMediaStore);
  const sessionManager =
    options.sessionManager ??
    new PlaybackSessionManager({
      ffmpegPath: options.ffmpegPath,
      preferredVideoEncoder: options.preferredVideoEncoder,
      maxConcurrentVideoTranscodes: options.maxConcurrentVideoTranscodes,
      softwareThreads: options.softwareTranscodeThreads,
    });
  const allowedOrigins = new Set(
    options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
  );
  const playbackHandler = createPlaybackRequestHandler({
    mediaStore,
    mediaResolver,
    sessionManager,
    basePath: "/api/playback",
    mediaRoot: configuredMediaRoot,
  });
  const tmdbArtworkHandler = createTmdbArtworkRequestHandler({
    mediaRoot: configuredMediaRoot,
    tmdbApiKey: options.tmdbApiKey,
    jellyfinServerUrl: options.jellyfinServerUrl,
    jellyfinApiKey: options.jellyfinApiKey,
    fetchImpl: options.fetchImpl,
  });
  const server = createServer(async (request, response) => {
    if (!applyCors(request, response, allowedOrigins)) {
      return;
    }

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (url.pathname === "/health") {
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("Allow", "GET, OPTIONS");
        response.end();
        return;
      }

      sendJson(response, 200, {
        status: "ok",
        service: "seyirlik-playback-backend",
      });
      return;
    }

    if (url.pathname === "/api/playback/runtime") {
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("Allow", "GET, OPTIONS");
        response.end();
        return;
      }

      sendJson(response, 200, sessionManager.getRuntimeStatus());
      return;
    }

    const handled =
      (await playbackHandler(request, response)) ||
      (await tmdbArtworkHandler(request, response));

    if (!handled) {
      sendJson(response, 404, {
        error: {
          code: "NOT_FOUND",
          message: "Route not found.",
        },
      });
    }
  });
  const cleanupTimer = setInterval(() => {
    void sessionManager.cleanupIdleSessions().catch((error) => {
      console.warn(
        "[Seyirlik Playback Backend] Idle session cleanup failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
  }, options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);

  cleanupTimer.unref();

  return {
    server,
    host,
    port,
    mediaRoot: providedResolver?.mediaRoot ?? configuredMediaRoot,
    sessionManager,
    close: async () => {
      clearInterval(cleanupTimer);
      await closeServer(server);
      await sessionManager.stopAllSessions();
    },
  };
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) {
    return DEFAULT_PORT;
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("SEYIRLIK_PLAYBACK_BACKEND_PORT must be a valid TCP port.");
  }

  return port;
}

function parseOptionalPositiveInteger(
  rawValue: string | undefined,
  variableName: string,
): number | undefined {
  if (!rawValue) {
    return undefined;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${variableName} must be a positive integer.`);
  }

  return value;
}

export async function startPlaybackBackendFromEnv(): Promise<PlaybackBackend> {
  const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT;
  const jellyfinServerUrl = process.env.SEYIRLIK_JELLYFIN_SERVER_URL;
  const jellyfinApiKey = process.env.SEYIRLIK_JELLYFIN_API_KEY;
  const tmdbApiKey = process.env.SEYIRLIK_TMDB_API_KEY;

  if (!mediaRoot) {
    throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
  }

  if (!jellyfinServerUrl) {
    throw new Error("SEYIRLIK_JELLYFIN_SERVER_URL is required.");
  }

  if (!jellyfinApiKey) {
    throw new Error("SEYIRLIK_JELLYFIN_API_KEY is required.");
  }

  const mediaResolver = await createJellyfinMediaResolver({
    mediaRoot,
    jellyfinServerUrl,
    apiKey: jellyfinApiKey,
    logger: console,
  });
  const backend = await createPlaybackBackend({
    host: process.env.SEYIRLIK_PLAYBACK_BACKEND_HOST ?? DEFAULT_HOST,
    port: parsePort(process.env.SEYIRLIK_PLAYBACK_BACKEND_PORT),
    mediaRoot,
    mediaResolver,
    allowedOrigins: parseAllowedOrigins(process.env.SEYIRLIK_ALLOWED_ORIGINS),
    tmdbApiKey,
    jellyfinServerUrl,
    jellyfinApiKey,
    ffmpegPath: process.env.SEYIRLIK_FFMPEG_PATH,
    preferredVideoEncoder:
      process.env.SEYIRLIK_FFMPEG_VIDEO_ENCODER ?? "auto",
    maxConcurrentVideoTranscodes: parseOptionalPositiveInteger(
      process.env.SEYIRLIK_MAX_VIDEO_TRANSCODES,
      "SEYIRLIK_MAX_VIDEO_TRANSCODES",
    ),
    softwareTranscodeThreads: parseOptionalPositiveInteger(
      process.env.SEYIRLIK_SOFTWARE_TRANSCODE_THREADS,
      "SEYIRLIK_SOFTWARE_TRANSCODE_THREADS",
    ),
  });

  await new Promise<void>((resolveListen) => {
    backend.server.listen(backend.port, backend.host, resolveListen);
  });

  console.info(
    `Seyirlik playback backend running at http://${backend.host}:${backend.port}`,
  );
  console.info(
    `Playback API mounted at http://${backend.host}:${backend.port}/api/playback`,
  );
  console.info(
    `TMDB artwork API mounted at http://${backend.host}:${backend.port}/api/tmdb-artwork`,
  );
  console.info(`Media root: ${backend.mediaRoot}`);

  const shutdown = async (signal: NodeJS.Signals) => {
    console.info(
      `[Seyirlik Playback Backend] ${signal} received; shutting down.`,
    );

    try {
      await backend.close();
      process.exit(0);
    } catch (error) {
      console.error(
        "[Seyirlik Playback Backend] Shutdown failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return backend;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  startPlaybackBackendFromEnv().catch((error) => {
    console.error(
      "[Seyirlik Playback Backend] Startup failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
