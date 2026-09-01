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
import {
  createRestartController,
  parseRestartConfig,
  respawnCurrentProcess,
  type RestartController,
} from "./restartController";
import { PlaybackSessionManager } from "../lib/playback-planner/playbackSessionManager";
import { PLAYBACK_SESSION_ROUTE_BASE } from "./ownApi/playback/playbackRoutes";
import {
  createOwnApiRequestHandler,
  isOwnApiPath,
  resolveOwnApiRequestId,
  type OwnApiLogger,
} from "./ownApi/ownApiHandler";
import { streamToResponse } from "./ownApi/api/fileDelivery";
import { installProcessSafetyNet } from "./processSafetyNet";
import { createRuntimeHealthService } from "./ownApi/runtimeHealthService";
import {
  createNativeRuntime,
  type NativeRuntime,
} from "./ownApi/nativeRuntime";

/**
 * Seyirlik's own media server.
 *
 * This process is the whole backend: identity, catalogue, artwork, playback and
 * background work all live behind `/ownAPI/v1`. It depends on no other media
 * server and has no fallback to one.
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
  /**
   * Enables the administrator restart endpoints.
   *
   * Off unless asked for, so a server embedded in a test cannot be told to end
   * the process running the test.
   */
  allowRestart?: boolean;
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

/**
 * How long a shutdown waits for connections to end themselves.
 *
 * A media server's connections are long by design — a two-hour film is one
 * response — so waiting for them to finish is waiting for ever, and the port
 * stays bound the whole time. That is not a tidy shutdown, it is a hung one,
 * and it is what turned a restart into a supervisor relaunching into
 * `EADDRINUSE` every ten seconds for half an hour.
 */
const CONNECTION_DRAIN_MS = 5_000;

/** A shutdown that has not finished by now is not going to; the process ends. */
const SHUTDOWN_DEADLINE_MS = 15_000;

/** How long to wait between attempts to bind a port somebody else holds. */
const LISTEN_RETRY_DELAY_MS = 2_000;

/** How often the wait for a busy port is repeated in the log. */
const LISTEN_RETRY_LOG_INTERVAL_MS = 30_000;

/** How long startup keeps waiting for a database that is not up yet. */
const DATABASE_WAIT_TIMEOUT_MS = 5 * 60_000;
const DATABASE_RETRY_DELAY_MS = 3_000;
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
    "encrypted" in request.socket && request.socket.encrypted
      ? "https"
      : "http";
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
        error: {
          code: "CORS_ORIGIN_DENIED",
          message: "Origin is not allowed.",
        },
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
    const segments = relative
      .split("/")
      .filter((segment) => segment.length > 0);

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

    await streamToResponse(createReadStream(filePath as string), response);
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

  /*
   * The restart controller has to exist before the routes that expose it, but
   * the shutdown it performs is this function's own `close`, which is not
   * built until the end. The indirection is the knot that ties: the controller
   * calls through this reference, and the reference is pointed at the real
   * shutdown once there is one.
   */
  let closeServer: () => Promise<void> = async () => undefined;
  const restartController: RestartController | undefined = options.allowRestart
    ? createRestartController({
        config: parseRestartConfig(options.environment ?? process.env),
        close: () => closeServer(),
        spawnReplacement: respawnCurrentProcess,
        exit: (code) => process.exit(code),
        delay: (ms) =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          }),
        logger: {
          info: (message) => console.info(message),
          error: (message) => console.error(message),
        },
      })
    : undefined;

  const runtime: NativeRuntime = await createNativeRuntime({
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
    trustedOrigins: configuredOrigins,
    mediaRoot,
    sessionManager,
    generatedStoragePath,
    ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
    ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
    ...(options.runWorker === undefined
      ? {}
      : { runWorker: options.runWorker }),
    ...(restartController ? { restartController } : {}),
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

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
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
  };

  /*
   * One request may not take the server down with it.
   *
   * Node calls this listener and drops the promise it returns on the floor, so
   * anything that rejects inside it becomes an unhandled rejection — which ends
   * the process. That is not a hypothetical: an aborted seek, a disk read that
   * failed half-way through a film, a route that threw after its headers were
   * already out. The blast radius of a failed request is that request.
   */
  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      logger.error?.("http.request.crashed", {
        method: request.method ?? "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });

      if (response.headersSent) {
        // Nothing can be said in a body that has already started; cutting the
        // connection is the only signal left.
        response.destroy();
        return;
      }

      response.statusCode = 500;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(
        JSON.stringify({
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "An internal server error occurred.",
          },
        }),
      );
    });
  });

  /*
   * A malformed request line, a TLS handshake sent to a plain HTTP port, a
   * proxy that hung up mid-header: all reach `clientError`, and the default
   * listener is fine — but a socket error raised with no listener attached is
   * not. Answering and closing keeps it a dropped connection rather than an
   * event nobody handled.
   */
  server.on("clientError", (_error, socket) => {
    if (!socket.writable || socket.destroyed) {
      socket.destroy();
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }

      /*
       * `server.close` stops accepting and then waits — for every open
       * connection, including the film somebody is half-way through and every
       * idle keep-alive socket the proxy is holding. On a media server that
       * wait has no end, and the port stays bound for the whole of it, so a
       * replacement process cannot start. Idle sockets go at once, and anything
       * still transferring is given a few seconds before it is cut.
       */
      const forceTimer = setTimeout(() => {
        server.closeAllConnections?.();
      }, CONNECTION_DRAIN_MS);
      forceTimer.unref();

      server.close((error) => {
        clearTimeout(forceTimer);
        if (error) reject(error);
        else resolve();
      });
      server.closeIdleConnections?.();
    });
    await sessionManager.stopAllSessions();
    await runtime.close();
  };
  closeServer = close;

  return { server, host, port, mediaRoot, close };
}

function parsePort(rawPort: string | undefined): number {
  if (!rawPort) return DEFAULT_PORT;
  const parsed = Number(rawPort);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error("SEYIRLIK_PORT must be a valid TCP port.");
  }
  return parsed;
}

/**
 * Whether this process also runs background jobs.
 *
 * Default `true`: one process is the right shape for one machine. Setting it
 * `false` splits the deployment in two — this process serves the site, and a
 * `mediaWorker` process scans, probes and encodes. They meet only in the
 * database, so either can be restarted without touching the other, and a
 * restart of the site no longer abandons an encode half-way through.
 */
export function parseRunWorker(rawValue: string | undefined): boolean {
  if (rawValue === undefined || rawValue.trim() === "") return true;
  const value = rawValue.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error("SEYIRLIK_RUN_WORKER must be true or false.");
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Binds the port, waiting rather than dying if something still holds it.
 *
 * The predecessor is often still letting go — a shutdown draining its last
 * connections, an orphan a supervisor has already given up on — and a `listen`
 * error is emitted on the server, where an unhandled `error` event ends the
 * process. Under a supervisor that produced the worst failure this server had:
 * relaunch, `EADDRINUSE`, exit, relaunch, for as long as the port stayed busy,
 * which on two occasions was over half an hour. Waiting costs seconds and ends
 * the moment the port is free; nothing else about the situation improves by
 * exiting into it again.
 */
export async function listenWithRetry(
  server: Server,
  port: number,
  host: string,
  retryDelayMs: number = LISTEN_RETRY_DELAY_MS,
): Promise<void> {
  const startedAt = Date.now();
  let lastLoggedAt = 0;

  for (;;) {
    const error = await new Promise<NodeJS.ErrnoException | undefined>(
      (resolve) => {
        const onError = (listenError: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          resolve(listenError);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(undefined);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      },
    );

    if (!error) return;
    if (error.code !== "EADDRINUSE") throw error;

    const waitedMs = Date.now() - startedAt;
    if (
      waitedMs === 0 ||
      waitedMs - lastLoggedAt >= LISTEN_RETRY_LOG_INTERVAL_MS
    ) {
      lastLoggedAt = waitedMs;
      console.warn(
        `[Seyirlik] ${host}:${port} is still held by another process; waiting for it (${Math.round(waitedMs / 1000)}s).`,
      );
    }

    await delay(retryDelayMs);
  }
}

/**
 * Starts the server, waiting out a database that is not up yet.
 *
 * On a machine that boots everything at once, PostgreSQL is regularly a few
 * seconds behind us, and refusing to start over that is how a supervisor ends
 * up relaunching into the same failure. A schema that is out of date is a
 * different matter: no amount of waiting fixes it, so it is raised at once.
 */
async function createMediaServerWaitingForDatabase(
  options: MediaServerOptions,
): Promise<MediaServer> {
  const startedAt = Date.now();
  let announced = false;

  for (;;) {
    try {
      return await createMediaServer(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const waitedMs = Date.now() - startedAt;
      if (
        message !== "The database is unavailable." ||
        waitedMs >= DATABASE_WAIT_TIMEOUT_MS
      ) {
        throw error;
      }

      if (!announced) {
        announced = true;
        console.warn(
          "[Seyirlik] The database is not accepting connections yet; waiting for it.",
        );
      }
      await delay(DATABASE_RETRY_DELAY_MS);
    }
  }
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

  const server = await createMediaServerWaitingForDatabase({
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
    // Only the real server process may restart itself; an embedded one is
    // somebody else's process to end.
    allowRestart: true,
    runWorker: parseRunWorker(process.env.SEYIRLIK_RUN_WORKER),
    preferredVideoEncoder: process.env.SEYIRLIK_FFMPEG_VIDEO_ENCODER ?? "auto",
    ...(maxVideoTranscodes === undefined
      ? {}
      : { maxConcurrentVideoTranscodes: maxVideoTranscodes }),
    ...(softwareThreads === undefined
      ? {}
      : { softwareTranscodeThreads: softwareThreads }),
  });

  await listenWithRetry(server.server, server.port, server.host);

  console.info(
    `Seyirlik media server running at http://${server.host}:${server.port}`,
  );
  console.info(
    `Own API mounted at http://${server.host}:${server.port}/ownAPI/v1`,
  );
  console.info(`Media root: ${server.mediaRoot}`);
  console.info(
    parseRunWorker(process.env.SEYIRLIK_RUN_WORKER)
      ? "Background jobs: in this process."
      : "Background jobs: delegated to a separate worker process.",
  );

  const shutdown = async (signal: NodeJS.Signals) => {
    console.info(`[Seyirlik] ${signal} received; shutting down.`);

    /*
     * The shutdown gets a deadline, and the deadline is kept.
     *
     * Whatever is slow to let go — an encoder ignoring its signal, a database
     * connection that will never answer — holding the port while waiting for it
     * is worse than leaving it behind, because the replacement cannot start
     * until this process is gone. Deliberately not unref'd: this timer is the
     * one thing that must still be able to end the process.
     */
    const deadline = setTimeout(() => {
      console.error(
        `[Seyirlik] Shutdown did not finish within ${Math.round(SHUTDOWN_DEADLINE_MS / 1000)}s; exiting anyway.`,
      );
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);

    try {
      await server.close();
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      clearTimeout(deadline);
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
  let serving: MediaServer | undefined;
  installProcessSafetyNet(() => serving?.server.listening === true);

  startMediaServerFromEnv()
    .then((server) => {
      serving = server;
    })
    .catch((error) => {
      console.error(
        "[Seyirlik] Startup failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });
}
