/*
 * First, and it has to stay first.
 *
 * `processBanner` writes the process's opening line from its own module body,
 * which — because ESM evaluates imports depth-first in source order — happens
 * before any module listed below it is even loaded. Move it down and the
 * announcement moves behind several hundred modules of `tsx` transpilation,
 * which is the silence this work exists to remove.
 */
import { moduleLoadElapsedMs } from "./startup/processBanner";
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
import {
  assertMediaRootDirectory,
  type AssertMediaRootOptions,
} from "./pathSecurity";
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
  type OwnApiHealthService,
  type OwnApiLogger,
} from "./ownApi/ownApiHandler";
import { streamToResponse } from "./ownApi/api/fileDelivery";
import { installProcessSafetyNet } from "./processSafetyNet";
import {
  createRuntimeHealthService,
  type RuntimeHealthServiceOptions,
} from "./ownApi/runtimeHealthService";
import {
  createNativeRuntime,
  type CreateNativeRuntimeOptions,
  type NativeRuntime,
} from "./ownApi/nativeRuntime";
import {
  awaitDependency,
  createDependencyGate,
} from "../renditions/processing/dependencyGate";
import {
  createStartupCoordinator,
  type StartupCoordinator,
} from "./startup/startupCoordinator";
import { createStartupReporter } from "./startup/startupReporter";
import { createStartupGate, type StartupGate } from "./startup/startupGate";

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

/**
 * Ceiling on the wait between storage probes.
 *
 * The same thirty seconds the worker uses, and for the same reason: an
 * unplugged drive should cost two probes a minute, not two a second, and an
 * operator plugging it back in should not wait longer than half a minute to be
 * noticed.
 */
const STORAGE_RETRY_MAX_DELAY_MS = 30_000;
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
      /*
       * Named on the first attempt, not after half a minute of silence.
       *
       * Two Seyirlik servers is an easy mistake to make — `launchctl kickstart`
       * and then `npm run server` in a terminal is all it takes — and the
       * symptom is a process that appears to start and never answers. The port
       * is the ownership token, so there is nothing to fix here beyond saying
       * plainly what is happening; the wait itself is deliberate and exists
       * because a predecessor still draining is the far more common case.
       */
      console.warn(
        waitedMs === 0
          ? `[Seyirlik] Could not bind ${host}:${port}: another process is holding it. ` +
              "Another Seyirlik server may already be running (check `launchctl list | grep seyirlik`). " +
              "Waiting for the port to be released."
          : `[Seyirlik] ${host}:${port} is still held by another process; waiting for it (${Math.round(waitedMs / 1000)}s).`,
      );
    }

    await delay(retryDelayMs);
  }
}

/**
 * The parts of the server that exist before any dependency does.
 *
 * Everything here is built from configuration alone — no filesystem, no
 * database, no subprocess — which is what makes it safe to have the port open
 * while the rest is still being assembled.
 */
interface MediaServerShell {
  server: Server;
  host: string;
  port: number;
  generatedStoragePath: string;
  allowedOrigins: Set<string>;
  logger: OwnApiLogger;
  /** Stops accepting and cuts what is left. Does not touch the runtime. */
  closeSockets(): Promise<void>;
}

function createMediaServerShell(
  options: MediaServerOptions,
  gate: StartupGate,
): MediaServerShell {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const generatedStoragePath = options.generatedStoragePath ?? tmpdir();
  const allowedOrigins = new Set(
    options.allowedOrigins ?? parseAllowedOrigins(undefined),
  );
  const publicOrigin = options.publicOrigin
    ? parseHttpOrigin(options.publicOrigin)
    : undefined;
  if (options.publicOrigin && !publicOrigin) {
    throw new Error("SEYIRLIK_PUBLIC_ORIGIN must be a valid HTTP(S) origin.");
  }

  const logger = options.logger ?? console;
  const serveStatic = options.staticRoot
    ? createStaticHandler(options.staticRoot)
    : undefined;

  /*
   * The gate is registered ahead of the runtime, and the runtime is reached
   * only through it. That ordering is the whole of the readiness contract:
   * `/ownAPI/v1/health` is answered above both, everything else meets the gate
   * first, and there is no path by which a route can be called before the
   * runtime that owns it exists.
   */
  const ownApiHandler = createOwnApiRequestHandler({
    healthService: gate.healthService,
    logger,
    routeHandlers: [gate.gateHandler, gate.runtimeHandler],
    routeTemplateResolver: gate.resolveRouteTemplate,
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

    /*
     * The built frontend is served whether or not startup has finished. The app
     * shell needs nothing from the database, and a browser that can load it
     * gets the startup state from `/health` and can say what is happening —
     * which is strictly better than the blank a 503 here would produce.
     */
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

  const closeSockets = async (): Promise<void> => {
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
  };

  return {
    server,
    host,
    port,
    generatedStoragePath,
    allowedOrigins,
    logger,
    closeSockets,
  };
}

export interface StartMediaServerOptions extends MediaServerOptions {
  /** Supply one to observe startup; a private one is created otherwise. */
  startup?: StartupCoordinator;
  /** Aborted on shutdown, so a dependency still being waited for stops. */
  signal?: AbortSignal;
  /** Injected in tests: resolving and validating the media root. */
  probeMediaRoot?: (
    mediaRoot: string,
    options?: AssertMediaRootOptions,
  ) => Promise<string>;
  /** Injected in tests: creating the generated-storage directory. */
  prepareGeneratedStorage?: (directory: string) => Promise<void>;
  /** Injected in tests: the database, jobs and routes. */
  createRuntime?: (
    options: CreateNativeRuntimeOptions,
  ) => Promise<NativeRuntime>;
  /** Injected in tests: binding the port. */
  bindListener?: (server: Server, port: number, host: string) => Promise<void>;
  /** Injected in tests, which have no ffmpeg to probe for. */
  createHealthService?: (
    options: RuntimeHealthServiceOptions,
  ) => OwnApiHealthService;
  databaseWaitTimeoutMs?: number;
  databaseRetryDelayMs?: number;
  /** Ceiling on the storage backoff. Matches the worker's. */
  storageRetryMaxDelayMs?: number;
}

export interface RunningMediaServer {
  server: Server;
  host: string;
  port: number;
  startup: StartupCoordinator;
  /**
   * Every required dependency is up and the routes are installed.
   *
   * Already handled internally, so ignoring it cannot produce an unhandled
   * rejection: a caller awaits it to find out, not to keep the process safe.
   */
  ready: Promise<void>;
  /** The real media root, once the storage phase has resolved one. */
  mediaRoot(): string | undefined;
  close(): Promise<void>;
}

/**
 * Starts the server, listener first.
 *
 * The order here is the point of this file. Everything that can be built from
 * configuration is built, the port is bound, and only then are the dependencies
 * brought up — so a volume that has stopped answering costs readiness rather
 * than the process, and the question "what is it doing?" has an answer over
 * HTTP for the whole of the wait rather than none of it.
 *
 * Returns as soon as the listener is answering. `ready` resolves later.
 */
export async function startMediaServer(
  options: StartMediaServerOptions,
): Promise<RunningMediaServer> {
  const {
    startup = createStartupCoordinator(),
    signal,
    probeMediaRoot = assertMediaRootDirectory,
    prepareGeneratedStorage = async (directory: string) => {
      await mkdir(directory, { recursive: true });
    },
    createRuntime = createNativeRuntime,
    bindListener = (server: Server, port: number, host: string) =>
      listenWithRetry(server, port, host),
    createHealthService = createRuntimeHealthService,
    databaseWaitTimeoutMs = DATABASE_WAIT_TIMEOUT_MS,
    databaseRetryDelayMs = DATABASE_RETRY_DELAY_MS,
    storageRetryMaxDelayMs = STORAGE_RETRY_MAX_DELAY_MS,
  } = options;

  const gate = createStartupGate({ snapshot: () => startup.snapshot() });

  let sessionManager: PlaybackSessionManager | undefined;
  let runtime: NativeRuntime | undefined;
  let resolvedMediaRoot: string | undefined;
  let closeServer: () => Promise<void> = async () => undefined;

  const shell = await startup.run(
    { id: "configuration", operation: "configure" },
    async () => createMediaServerShell(options, gate),
  );

  /*
   * The restart controller has to exist before the routes that expose it, but
   * the shutdown it performs is this function's own `close`, which is not built
   * until the end. The indirection is the knot that ties: the controller calls
   * through this reference, and the reference is pointed at the real shutdown
   * once there is one.
   */
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

  await startup.run(
    {
      id: "listener",
      operation: "listen",
      resource: `${shell.host}:${shell.port}`,
      // `listenWithRetry` narrates a busy port itself, and degrading a phase
      // the process is not yet live for would describe nothing.
      stillWaitingEveryMs: 0,
      degradeAfterMs: null,
    },
    async () => {
      await bindListener(shell.server, shell.port, shell.host);
    },
  );
  startup.markLive();

  /**
   * Waits for a storage root, without ever running two probes at once.
   *
   * The gate is the same primitive the worker waits on, and it is chosen for
   * one property above all the others: a probe that has not answered is never
   * re-issued. A blocked `stat()` holds a libuv worker thread, the pool has
   * four of them, and a retry loop that launched a fresh `stat` every few
   * seconds against a volume that answers none of them would exhaust the pool
   * in under a minute — taking every other file operation in the process,
   * including the ones serving video, down with it.
   */
  const awaitStorageRoot = async (
    id: "media-storage" | "generated-storage",
    label: string,
    resource: string,
    operation: string,
    probe: (report: (operation: string) => void) => Promise<void>,
  ): Promise<void> => {
    const gateForRoot = createDependencyGate({
      name: label,
      probe: () => probe((next) => startup.update(id, { operation: next })),
      maxDelayMs: storageRetryMaxDelayMs,
      onStateChange: (state, detail) => {
        startup.update(id, { detail });
        // One line when it goes, one when it comes back, however long it lasts.
        if (state === "unavailable") console.warn(`[Seyirlik] ${detail}`);
      },
    });

    await startup.run({ id, operation, resource }, async (context) => {
      const satisfied = await awaitDependency({
        gate: gateForRoot,
        /*
         * The gate decides the cadence; this only records it. Reporting from
         * here rather than from `onStateChange` is deliberate: a transition
         * happens once, so a snapshot taken a minute into an outage would
         * otherwise still be advertising the retry that was due at second one.
         */
        sleep: async (ms) => {
          context.update({
            attempt: gateForRoot.probeCount,
            ...(gateForRoot.nextAttemptAtMs === null
              ? {}
              : { nextAttemptAtMs: gateForRoot.nextAttemptAtMs }),
          });
          await delay(ms);
        },
        ...(signal ? { signal } : {}),
      });
      context.update({ attempt: gateForRoot.probeCount });
      if (!satisfied) {
        throw new Error("Shutdown began before the storage root answered.");
      }
    });
  };

  const initialise = async (): Promise<void> => {
    await awaitStorageRoot(
      "media-storage",
      "The media root",
      path.resolve(options.mediaRoot),
      "stat",
      async (report) => {
        resolvedMediaRoot = await probeMediaRoot(options.mediaRoot, {
          onOperation: report,
        });
      },
    );
    const mediaRoot = resolvedMediaRoot;
    if (mediaRoot === undefined) {
      throw new Error("The media root did not resolve.");
    }

    await awaitStorageRoot(
      "generated-storage",
      "The generated-storage directory",
      shell.generatedStoragePath,
      "mkdir",
      async (report) => {
        report("mkdir");
        // Generated storage belongs to Seyirlik, unlike the media root, which
        // must already exist and is never created on our behalf.
        await prepareGeneratedStorage(shell.generatedStoragePath);
      },
    );

    sessionManager = new PlaybackSessionManager({
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      outputRoot: shell.generatedStoragePath,
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

    /*
     * The database and processing phases are reported from inside
     * `createNativeRuntime`, because only it knows where one ends and the other
     * begins. The retry lives out here, because only this loop knows that a
     * database which is not up yet is worth waiting for while a schema that is
     * out of date is not.
     */
    const runtimeOptions: CreateNativeRuntimeOptions = {
      ...(options.environment ? { environment: options.environment } : {}),
      ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
      trustedOrigins: shell.allowedOrigins,
      mediaRoot,
      sessionManager,
      generatedStoragePath: shell.generatedStoragePath,
      ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
      ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
      ...(options.softwareTranscodeThreads === undefined
        ? {}
        : { softwareTranscodeThreads: options.softwareTranscodeThreads }),
      ...(options.runWorker === undefined
        ? {}
        : { runWorker: options.runWorker }),
      ...(restartController ? { restartController } : {}),
      startup,
    };

    const startedWaitingAtMs = Date.now();
    for (let attempt = 1; ; attempt += 1) {
      try {
        runtime = await createRuntime(runtimeOptions);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const waitedMs = Date.now() - startedWaitingAtMs;
        if (
          signal?.aborted ||
          message !== "The database is unavailable." ||
          waitedMs >= databaseWaitTimeoutMs
        ) {
          startup.failRunning(error);
          throw error;
        }

        if (attempt === 1) {
          console.warn(
            "[Seyirlik] The database is not accepting connections yet; waiting for it.",
          );
        }
        startup.update("database", {
          attempt,
          nextAttemptAtMs: Date.now() + databaseRetryDelayMs,
          detail: "Not accepting connections yet; waiting.",
        });
        await delay(databaseRetryDelayMs);
      }
    }

    /*
     * Shutdown can land in the gap between the runtime being built and it being
     * installed. A runtime nobody holds a reference to still owns a connection
     * pool, a storage watchdog and possibly a worker, so it is closed here
     * rather than left to the garbage collector, which would not close any of
     * them.
     */
    if (startup.stopping || signal?.aborted) {
      const orphan = runtime;
      runtime = undefined;
      await orphan?.close().catch(() => undefined);
      throw new Error("Shutdown began before startup finished.");
    }

    const installed = runtime;
    await startup.run({ id: "routes", operation: "install" }, async () => {
      gate.install({
        routeHandler: installed.routeHandler,
        resolveRouteTemplate: installed.resolveRouteTemplate,
        healthService: createHealthService({
          ...(options.ffmpegPath ? { ffmpegPath: options.ffmpegPath } : {}),
          ...(options.ffprobePath ? { ffprobePath: options.ffprobePath } : {}),
          mediaStoragePath: mediaRoot,
          generatedStoragePath:
            sessionManager?.outputRoot ?? shell.generatedStoragePath,
          databaseCheck: installed.databaseCheck,
          jobsCheck: installed.jobsCheck,
        }),
      });
    });
  };

  const ready = initialise().then(
    () => {
      startup.finish();
    },
    (error) => {
      startup.finish();
      throw error;
    },
  );
  // Handled here so that a caller which never awaits `ready` cannot turn a
  // startup failure into an unhandled rejection.
  ready.catch(() => undefined);

  const close = async (): Promise<void> => {
    startup.stop();
    await shell.closeSockets();
    await sessionManager?.stopAllSessions();
    await runtime?.close();
    startup.finish();
    startup.dispose();
  };
  closeServer = close;

  return {
    server: shell.server,
    host: shell.host,
    port: shell.port,
    startup,
    ready,
    mediaRoot: () => resolvedMediaRoot,
    close,
  };
}

/**
 * Starts the server from the process environment, and narrates it.
 *
 * Resolves as soon as the listener is answering, not when the server is ready.
 * The two are different events now, and the caller wants the first: from that
 * moment a fault is something to report rather than something to exit over, and
 * `/ownAPI/v1/health` can describe whatever happens next.
 */
export async function startMediaServerFromEnv(): Promise<RunningMediaServer> {
  const reporter = createStartupReporter();
  const startup = createStartupCoordinator({ observer: reporter });
  reporter.processStarting({
    pid: process.pid,
    moduleLoadMs: moduleLoadElapsedMs(),
  });

  /*
   * Everything up to the listener can throw — an unset media root, a port that
   * is not a number, an origin list with a typo — and in a terminal the
   * reporter has stdout wrapped by then. Releasing it on the way out means the
   * message that explains the mistake is printed to an ordinary stream.
   */
  try {
    return await startFromEnvironment(startup, reporter);
  } catch (error) {
    reporter.dispose();
    throw error;
  }
}

async function startFromEnvironment(
  startup: StartupCoordinator,
  reporter: ReturnType<typeof createStartupReporter>,
): Promise<RunningMediaServer> {
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
  const runWorker = parseRunWorker(process.env.SEYIRLIK_RUN_WORKER);

  /*
   * Aborted by the signal handlers below. Without it a SIGTERM arriving while
   * the media root is being waited for would be queued behind a backoff sleep,
   * and the supervisor would be waiting on a process whose only remaining work
   * is to notice it should stop.
   */
  const shutdown = new AbortController();

  const server = await startMediaServer({
    startup,
    signal: shutdown.signal,
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
    runWorker,
    preferredVideoEncoder: process.env.SEYIRLIK_FFMPEG_VIDEO_ENCODER ?? "auto",
    ...(maxVideoTranscodes === undefined
      ? {}
      : { maxConcurrentVideoTranscodes: maxVideoTranscodes }),
    ...(softwareThreads === undefined
      ? {}
      : { softwareTranscodeThreads: softwareThreads }),
  });

  /*
   * Said once the port is open, which is now genuinely true when it is said.
   * These two lines are what an operator greps the log for, and until this
   * change they appeared only after every dependency had answered — so on the
   * day the volume stopped answering, they never appeared at all.
   */
  console.info(
    `Seyirlik media server listening at http://${server.host}:${server.port}`,
  );
  console.info(
    `Own API mounted at http://${server.host}:${server.port}/ownAPI/v1`,
  );
  console.info(
    runWorker
      ? "Background jobs: in this process."
      : "Background jobs: delegated to a separate worker process.",
  );

  const stop = async (signal: NodeJS.Signals) => {
    console.info(`[Seyirlik] ${signal} received; shutting down.`);
    shutdown.abort();

    /*
     * The shutdown gets a deadline, and the deadline is kept.
     *
     * Whatever is slow to let go — an encoder ignoring its signal, a database
     * connection that will never answer, a `stat` still blocked in the kernel
     * on a volume that has stopped answering — holding the port while waiting
     * for it is worse than leaving it behind, because the replacement cannot
     * start until this process is gone. Deliberately not unref'd: this timer is
     * the one thing that must still be able to end the process.
     */
    const deadline = setTimeout(() => {
      console.error(
        `[Seyirlik] Shutdown did not finish within ${Math.round(SHUTDOWN_DEADLINE_MS / 1000)}s; exiting anyway.`,
      );
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS);

    try {
      await server.close();
      reporter.dispose();
      clearTimeout(deadline);
      process.exit(0);
    } catch (error) {
      reporter.dispose();
      clearTimeout(deadline);
      console.error(
        "[Seyirlik] Shutdown failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    }
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  /*
   * A startup that fails after the listener is up still ends the process.
   *
   * It is tempting to stay alive and serve the failure over `/health`, and for
   * a slow volume that is exactly what happens — that path degrades and never
   * throws. But the failures that reach here are the ones no amount of waiting
   * fixes: a schema that needs migrating, a port that cannot be bound, storage
   * that answered with something other than a directory. Under `KeepAlive` the
   * supervisor relaunches, which is the right amount of noise for a mistake
   * that needs a person, and staying up would replace it with a server that
   * looks alive and serves nothing but 503s for ever.
   */
  server.ready
    .then(() => {
      reporter.dispose();
    })
    .catch((error) => {
      reporter.dispose();
      console.error(
        "[Seyirlik] Startup failed:",
        error instanceof Error ? error.message : String(error),
      );
      process.exit(1);
    });

  return server;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  let serving: RunningMediaServer | undefined;
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
