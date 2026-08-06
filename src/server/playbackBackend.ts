import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
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
import {
  createFirebaseAdminAuthorizerFromEnv,
  createUnavailableAdminAuthorizer,
  type AdminRequestAuthorizer,
} from "./firebaseAdminAuth";
import {
  createOwnApiRequestHandler,
  isOwnApiPath,
  ownApiRouteTemplate,
  resolveOwnApiRequestId,
  type OwnApiHealthService,
  type OwnApiLogger,
  type OwnApiRouteHandler,
} from "./ownApi/ownApiHandler";
import { createRuntimeHealthService } from "./ownApi/runtimeHealthService";
import { createNativeIdentityRuntime } from "./ownApi/auth/nativeIdentityRuntime";
import { createRenditionService } from "./renditionService";
import {
  createJellyfinPlaybackAuthorizer,
  type PlaybackRequestAuthorizer,
} from "./jellyfinPlaybackAuth";

export interface PlaybackBackendOptions {
  host?: string;
  port?: number;
  mediaRoot?: string;
  allowedOrigins?: string[];
  publicOrigin?: string;
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
  ffprobePath?: string;
  generatedStoragePath?: string;
  renditionRoot?: string;
  renditionStateRoot?: string;
  preferredVideoEncoder?: string;
  maxConcurrentVideoTranscodes?: number;
  softwareTranscodeThreads?: number;
  adminAuthorizer?: AdminRequestAuthorizer;
  playbackAuthorizer?: PlaybackRequestAuthorizer;
  ownApiHealthService?: OwnApiHealthService;
  ownApiLogger?: OwnApiLogger;
  ownApiRouteHandlers?: OwnApiRouteHandler[];
  ownApiDatabaseCheck?: () => Promise<"available" | "unavailable">;
  ownApiShutdown?: () => Promise<void>;
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
  "https://www.seyirlik.org",
  "https://seyirlik.org",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];
const SERVER_DIAGNOSTICS_TIMEOUT_MS = 3500;

interface ServerConnectionProbe {
  url: string;
  endpoint?: string;
  ok: boolean;
  reachable: boolean;
  kind:
    | "jellyfin"
    | "cloudflare-bad-gateway"
    | "cloudflare-tunnel-error"
    | "cloudflare-error"
    | "http-ok"
    | "http-error"
    | "network-error"
    | "not-configured";
  status?: number;
  statusText?: string;
  message?: string;
  productName?: string;
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

function normalizeDiagnosticServerUrl(rawServerUrl: string): string {
  const parsedUrl = new URL(rawServerUrl.trim());

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Server URL must use http or https.");
  }

  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString().replace(/\/+$/, "");
}

function buildPublicInfoUrl(serverUrl: string): string {
  const normalizedServerUrl = normalizeDiagnosticServerUrl(serverUrl);
  const endpoint = new URL("System/Info/Public", `${normalizedServerUrl}/`);
  endpoint.searchParams.set("seyirlikDiagnostics", String(Date.now()));
  return endpoint.toString();
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detectServerProbeKind(
  status: number,
  statusText: string,
  bodyText: string,
): ServerConnectionProbe["kind"] {
  const searchableText = `${statusText}\n${bodyText}`;

  if (status === 502 || /bad gateway|error code 502/i.test(searchableText)) {
    return "cloudflare-bad-gateway";
  }

  if (
    status === 530 ||
    /error 1033|cloudflare tunnel error/i.test(searchableText)
  ) {
    return "cloudflare-tunnel-error";
  }

  if (/cloudflare/i.test(searchableText)) {
    return "cloudflare-error";
  }

  return "http-error";
}

function getJellyfinProductName(bodyText: string): string | undefined {
  try {
    const json = JSON.parse(bodyText) as {
      ProductName?: string;
      ServerName?: string;
    };

    return json.ProductName || json.ServerName;
  } catch {
    return undefined;
  }
}

async function probeServerConnection(
  rawServerUrl: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ServerConnectionProbe | null> {
  if (!rawServerUrl) {
    return null;
  }

  let serverUrl: string;
  let endpoint: string;

  try {
    serverUrl = normalizeDiagnosticServerUrl(rawServerUrl);
    endpoint = buildPublicInfoUrl(serverUrl);
  } catch (error) {
    return {
      url: rawServerUrl,
      ok: false,
      reachable: false,
      kind: "not-configured",
      message: getErrorMessage(error),
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, SERVER_DIAGNOSTICS_TIMEOUT_MS);

  try {
    const probeResponse = await fetchImpl(endpoint, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/html;q=0.8",
      },
    });
    const bodyText = await probeResponse.text().catch(() => "");
    const productName = getJellyfinProductName(bodyText);

    if (probeResponse.ok) {
      return {
        url: serverUrl,
        endpoint,
        ok: true,
        reachable: true,
        kind: productName ? "jellyfin" : "http-ok",
        status: probeResponse.status,
        statusText: probeResponse.statusText,
        productName,
      };
    }

    return {
      url: serverUrl,
      endpoint,
      ok: false,
      reachable: true,
      kind: detectServerProbeKind(
        probeResponse.status,
        probeResponse.statusText,
        bodyText,
      ),
      status: probeResponse.status,
      statusText: probeResponse.statusText,
      message:
        bodyText || `${probeResponse.status} ${probeResponse.statusText}`,
    };
  } catch (error) {
    return {
      url: serverUrl,
      endpoint,
      ok: false,
      reachable: false,
      kind: "network-error",
      message: getErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseAllowedOrigins(
  rawOrigins: string | undefined,
  environment = process.env.NODE_ENV,
): string[] {
  if (rawOrigins === undefined) {
    return environment === "production" ? [] : [...DEFAULT_ALLOWED_ORIGINS];
  }

  const configuredOrigins = rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map(normalizeAllowedOrigin);

  return Array.from(new Set(configuredOrigins));
}

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

function normalizeAllowedOrigin(value: string): string {
  const origin = parseHttpOrigin(value);

  if (!origin) {
    throw new Error(
      "SEYIRLIK_ALLOWED_ORIGINS must contain only valid HTTP(S) origins without paths.",
    );
  }

  return origin;
}

function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: Set<string>,
  publicOrigin: string | undefined,
): boolean {
  const origin = request.headers.origin;

  if (!origin) {
    return true;
  }

  const isSameOrigin =
    typeof origin === "string" &&
    origin === (publicOrigin ?? requestOrigin(request));

  if (Array.isArray(origin) || (!isSameOrigin && !allowedOrigins.has(origin))) {
    const responseRequestId = response.getHeader("X-Request-Id");
    const requestId =
      typeof responseRequestId === "string" ? responseRequestId : undefined;

    sendJson(response, 403, {
      error: {
        code: "CORS_ORIGIN_DENIED",
        message: "Origin is not allowed.",
        ...(requestId ? { requestId } : {}),
      },
    });
    return false;
  }

  if (isSameOrigin) {
    return true;
  }

  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Range, Authorization, X-Emby-Authorization, X-Emby-Token, X-Request-Id, X-CSRF-Token",
  );
  response.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, X-Request-Id",
  );
  return true;
}

function requestOrigin(request: IncomingMessage): string | undefined {
  const host = request.headers.host;

  if (!host) {
    return undefined;
  }

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

function normalizePublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const origin = parseHttpOrigin(value);

  if (!origin) {
    throw new Error("SEYIRLIK_PUBLIC_ORIGIN must be a valid HTTP(S) origin.");
  }

  return origin;
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
  const analysisCache = new InMemoryAnalysisCache(
    undefined,
    options.ffprobePath,
  );
  const mediaStore: PlaybackMediaStore =
    options.mediaStore ??
    ({
      getMediaAnalysis: (media) => analysisCache.getOrAnalyse(media),
      saveClientCapabilities: () => undefined,
    } satisfies PlaybackMediaStore);
  const configuredGeneratedStoragePath =
    options.generatedStoragePath ?? tmpdir();
  const sessionManager =
    options.sessionManager ??
    new PlaybackSessionManager({
      ffmpegPath: options.ffmpegPath,
      outputRoot: configuredGeneratedStoragePath,
      preferredVideoEncoder: options.preferredVideoEncoder,
      maxConcurrentVideoTranscodes: options.maxConcurrentVideoTranscodes,
      softwareThreads: options.softwareTranscodeThreads,
    });
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? parseAllowedOrigins(undefined)).map(
      normalizeAllowedOrigin,
    ),
  );
  const publicOrigin = normalizePublicOrigin(options.publicOrigin);
  const adminAuthorizer =
    options.adminAuthorizer ?? createUnavailableAdminAuthorizer();
  const renditionService = createRenditionService({
    mediaRoot: configuredMediaRoot,
    renditionRoot:
      options.renditionRoot ??
      path.join(configuredMediaRoot, ".seyirlik", "renditions"),
    stateRoot:
      options.renditionStateRoot ??
      path.join(configuredMediaRoot, ".seyirlik", "state"),
    mediaResolver,
  });
  const playbackHandler = createPlaybackRequestHandler({
    mediaStore,
    mediaResolver,
    sessionManager,
    basePath: "/api/playback",
    mediaRoot: configuredMediaRoot,
    authorizeRequest: options.playbackAuthorizer,
    getRenditionManifest: (resolvedMedia, analysis, plan, capabilities) => {
      const video = analysis.videoStreams[0];
      return renditionService.createManifest(
        resolvedMedia,
        video && !plan.requiresFfmpeg
          ? {
              width: video.width,
              height: video.height,
              codec: video.codecName,
              container:
                analysis.container.extension ?? analysis.container.formatName,
              fileSize: resolvedMedia.size,
              playableUrl: plan.delivery.url,
            }
          : undefined,
        {
          hevc: capabilities.video.hevc?.supported === true,
          h264: capabilities.video.h264?.supported !== false,
        },
      );
    },
  });
  const tmdbArtworkHandler = createTmdbArtworkRequestHandler({
    mediaRoot: configuredMediaRoot,
    tmdbApiKey: options.tmdbApiKey,
    jellyfinServerUrl: options.jellyfinServerUrl,
    jellyfinApiKey: options.jellyfinApiKey,
    fetchImpl: options.fetchImpl,
  });
  const ownApiHealthService =
    options.ownApiHealthService ??
    createRuntimeHealthService({
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
      mediaStoragePath: configuredMediaRoot,
      generatedStoragePath:
        sessionManager.outputRoot ?? configuredGeneratedStoragePath,
      databaseCheck: options.ownApiDatabaseCheck,
    });
  const ownApiLogger = options.ownApiLogger ?? console;
  const ownApiHandler = createOwnApiRequestHandler({
    healthService: ownApiHealthService,
    logger: ownApiLogger,
    routeHandlers: options.ownApiRouteHandlers,
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const ownApiPath = isOwnApiPath(url.pathname);
    const ownApiStartedAt = ownApiPath ? performance.now() : undefined;

    if (ownApiPath) {
      response.setHeader("X-Request-Id", resolveOwnApiRequestId(request));
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
    }

    if (!applyCors(request, response, allowedOrigins, publicOrigin)) {
      if (ownApiPath) {
        ownApiLogger.info("http.request.completed", {
          requestId: String(response.getHeader("X-Request-Id")),
          method: request.method ?? "UNKNOWN",
          path: ownApiRouteTemplate(url.pathname),
          statusCode: response.statusCode,
          durationMs: Math.max(
            0,
            Math.round(
              performance.now() - (ownApiStartedAt ?? performance.now()),
            ),
          ),
        });
      }

      return;
    }

    if (await ownApiHandler(request, response)) {
      return;
    }

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }

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

    if (url.pathname === "/api/server-diagnostics") {
      if (request.method !== "GET") {
        response.statusCode = 405;
        response.setHeader("Allow", "GET, OPTIONS");
        response.end();
        return;
      }

      const publicServerUrl = url.searchParams.get("serverUrl") ?? undefined;
      const fetchImpl = options.fetchImpl ?? fetch;
      const [publicProbe, localProbe] = await Promise.all([
        probeServerConnection(publicServerUrl, fetchImpl),
        probeServerConnection(options.jellyfinServerUrl, fetchImpl),
      ]);

      if (!publicProbe) {
        sendJson(response, 400, {
          error: {
            code: "SERVER_URL_REQUIRED",
            message: "serverUrl query parameter is required.",
          },
        });
        return;
      }

      sendJson(response, 200, {
        checkedAt: new Date().toISOString(),
        publicProbe,
        localProbe,
        localProbeUrls: localProbe?.url ? [localProbe.url] : [],
      });
      return;
    }

    if (
      url.pathname === "/api/tmdb-artwork" ||
      url.pathname.startsWith("/api/tmdb-artwork/")
    ) {
      const authorization = await adminAuthorizer(request);

      if (!authorization.authorized) {
        sendJson(response, authorization.statusCode, {
          error: {
            code: authorization.code,
            message: authorization.message,
          },
        });
        return;
      }
    }

    const handled =
      (await renditionService.handleRequest(request, response)) ||
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
      await options.ownApiShutdown?.();
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

/**
 * Playback requests are authorized against Jellyfin by default because that is
 * the identity provider this deployment ships with. Deployments that issue their
 * own session tokens can opt out with SEYIRLIK_PLAYBACK_AUTH=disabled instead of
 * silently failing every playback request against an unrelated Jellyfin server.
 */
function createPlaybackAuthorizerFromEnv(
  jellyfinServerUrl: string,
): PlaybackRequestAuthorizer | undefined {
  const mode = process.env.SEYIRLIK_PLAYBACK_AUTH?.trim().toLowerCase();

  if (mode === "disabled") {
    return undefined;
  }

  if (mode && mode !== "jellyfin") {
    throw new Error(
      "SEYIRLIK_PLAYBACK_AUTH must be either `jellyfin` or `disabled`.",
    );
  }

  return createJellyfinPlaybackAuthorizer({ jellyfinServerUrl });
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
  const publicOrigin = process.env.SEYIRLIK_PUBLIC_ORIGIN?.trim() || undefined;
  const nativeIdentityRuntime = await createNativeIdentityRuntime({
    environment: process.env,
    publicOrigin,
  });
  let backend: PlaybackBackend;

  try {
    backend = await createPlaybackBackend({
      host: process.env.SEYIRLIK_PLAYBACK_BACKEND_HOST ?? DEFAULT_HOST,
      port: parsePort(process.env.SEYIRLIK_PLAYBACK_BACKEND_PORT),
      mediaRoot,
      mediaResolver,
      allowedOrigins: parseAllowedOrigins(process.env.SEYIRLIK_ALLOWED_ORIGINS),
      publicOrigin,
      tmdbApiKey,
      jellyfinServerUrl,
      jellyfinApiKey,
      ffmpegPath: process.env.SEYIRLIK_FFMPEG_PATH,
      ffprobePath: process.env.SEYIRLIK_FFPROBE_PATH,
      generatedStoragePath: process.env.SEYIRLIK_GENERATED_STORAGE,
      renditionRoot: process.env.SEYIRLIK_RENDITION_ROOT,
      renditionStateRoot: process.env.SEYIRLIK_RENDITION_STATE_ROOT,
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
      adminAuthorizer: createFirebaseAdminAuthorizerFromEnv(),
      playbackAuthorizer: createPlaybackAuthorizerFromEnv(jellyfinServerUrl),
      ownApiRouteHandlers: nativeIdentityRuntime
        ? [nativeIdentityRuntime.routeHandler]
        : [],
      ownApiDatabaseCheck: nativeIdentityRuntime?.databaseCheck,
      ownApiShutdown: nativeIdentityRuntime?.close,
    });
  } catch (error) {
    await nativeIdentityRuntime?.close().catch(() => undefined);
    throw error;
  }

  await new Promise<void>((resolveListen) => {
    backend.server.listen(backend.port, backend.host, resolveListen);
  });

  console.info(
    `Seyirlik playback backend running at http://${backend.host}:${backend.port}`,
  );
  console.info(
    `Seyirlik own API mounted at http://${backend.host}:${backend.port}/ownAPI/v1`,
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
