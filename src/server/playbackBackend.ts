import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryAnalysisCache } from "./analysisCache";
import { createMediaRegistry, type MediaRegistry } from "./mediaRegistry";
import {
  createPlaybackRequestHandler,
  type PlaybackMediaStore,
} from "../lib/playback-planner/playbackRoutes";
import { PlaybackSessionManager } from "../lib/playback-planner/playbackSessionManager";

export interface PlaybackBackendOptions {
  host?: string;
  port?: number;
  mediaRoot?: string;
  allowedOrigins?: string[];
  cleanupIntervalMs?: number;
  mediaRegistry?: MediaRegistry;
  mediaStore?: PlaybackMediaStore;
  sessionManager?: PlaybackSessionManager;
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
  const resolvedRoot = path.resolve(mediaRoot);
  const mediaRootStat = await stat(resolvedRoot).catch(() => null);

  if (!mediaRootStat?.isDirectory()) {
    throw new Error(
      "SEYIRLIK_MEDIA_ROOT must point to an existing media directory.",
    );
  }

  return resolvedRoot;
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
  const configuredMediaRoot = options.mediaRegistry
    ? options.mediaRegistry.mediaRoot
    : options.mediaRoot
      ? await assertConfiguredMediaRoot(options.mediaRoot)
      : (() => {
          throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
        })();
  const mediaRegistry =
    options.mediaRegistry ?? (await createMediaRegistry(configuredMediaRoot));
  const analysisCache = new InMemoryAnalysisCache();
  const mediaStore: PlaybackMediaStore =
    options.mediaStore ??
    ({
      getMediaAnalysis: (media) => analysisCache.getOrAnalyse(media),
      saveClientCapabilities: () => undefined,
    } satisfies PlaybackMediaStore);
  const sessionManager = options.sessionManager ?? new PlaybackSessionManager();
  const allowedOrigins = new Set(
    options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
  );
  const playbackHandler = createPlaybackRequestHandler({
    mediaStore,
    mediaResolver: mediaRegistry,
    sessionManager,
    basePath: "/api/playback",
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

    const handled = await playbackHandler(request, response);

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
    mediaRoot: mediaRegistry.mediaRoot,
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

export async function startPlaybackBackendFromEnv(): Promise<PlaybackBackend> {
  const mediaRoot = process.env.SEYIRLIK_MEDIA_ROOT;

  if (!mediaRoot) {
    throw new Error("SEYIRLIK_MEDIA_ROOT is required.");
  }

  const backend = await createPlaybackBackend({
    host: process.env.SEYIRLIK_PLAYBACK_BACKEND_HOST ?? DEFAULT_HOST,
    port: parsePort(process.env.SEYIRLIK_PLAYBACK_BACKEND_PORT),
    mediaRoot,
    allowedOrigins: parseAllowedOrigins(process.env.SEYIRLIK_ALLOWED_ORIGINS),
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
