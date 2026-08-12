import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const OWN_API_V1_BASE_PATH = "/ownAPI/v1";

export type OwnApiAccess = "public" | "authenticated" | "admin";

export interface OwnApiPrincipal {
  userId: string;
  sessionId: string;
  deviceId: string;
  roles: string[];
}

export interface OwnApiRequestContext {
  requestId: string;
  principal: OwnApiPrincipal | null;
}

export type OptionalDependencyStatus = "available" | "unavailable" | "disabled";
export type RequiredDependencyStatus = "available" | "unavailable";
export type WritableStorageStatus = "writable" | "unavailable";

export interface OwnApiHealthChecks {
  database: OptionalDependencyStatus;
  jobs: OptionalDependencyStatus;
  ffmpeg: RequiredDependencyStatus;
  ffprobe: RequiredDependencyStatus;
  mediaStorage: RequiredDependencyStatus;
  generatedStorage: WritableStorageStatus;
}

export interface OwnApiHealthStatus {
  status: "ok";
  alive: true;
  ready: boolean;
  checks: OwnApiHealthChecks;
}

export interface OwnApiHealthService {
  getStatus(): Promise<OwnApiHealthStatus>;
}

export interface OwnApiLogger {
  info(event: string, context: Record<string, unknown>): void;
  warn?(event: string, context: Record<string, unknown>): void;
  error?(event: string, context: Record<string, unknown>): void;
}

export type OwnApiAuthenticator = (
  request: IncomingMessage,
) => Promise<OwnApiPrincipal | null>;

export interface OwnApiRequestHandlerOptions {
  healthService: OwnApiHealthService;
  requestIdFactory?: () => string;
  authenticator?: OwnApiAuthenticator;
  logger?: OwnApiLogger;
  routeHandlers?: OwnApiRouteHandler[];
  /**
   * Maps a request path to the fixed route template used in structured logs.
   * Falls back to the coarse `/ownAPI/v1/*` template when a route is unknown, so
   * a caller-controlled path segment can never reach the log stream.
   */
  routeTemplateResolver?: (pathname: string) => string | undefined;
}

export interface OwnApiRouteContext {
  requestId: string;
  url: URL;
}

export type OwnApiRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: OwnApiRouteContext,
) => Promise<boolean>;

export class OwnApiError extends Error {
  code: string;
  statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "OwnApiError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isOwnApiPath(pathname: string): boolean {
  return (
    pathname === OWN_API_V1_BASE_PATH ||
    pathname.startsWith(`${OWN_API_V1_BASE_PATH}/`)
  );
}

export function buildOwnApiHealthStatus(
  checks: OwnApiHealthChecks,
): OwnApiHealthStatus {
  const ready =
    checks.database === "available" &&
    checks.jobs === "available" &&
    checks.ffmpeg === "available" &&
    checks.ffprobe === "available" &&
    checks.mediaStorage === "available" &&
    checks.generatedStorage === "writable";

  return {
    status: "ok",
    alive: true,
    ready,
    checks: { ...checks },
  };
}

export function createStaticHealthService(
  checks: OwnApiHealthChecks,
): OwnApiHealthService {
  return {
    getStatus: async () => buildOwnApiHealthStatus(checks),
  };
}

export function resolveOwnApiRequestId(
  request: IncomingMessage,
  requestIdFactory: () => string = randomUUID,
  existingRequestId?: string | number | readonly string[],
): string {
  const existing = Array.isArray(existingRequestId)
    ? existingRequestId[0]
    : existingRequestId;

  if (typeof existing === "string" && REQUEST_ID_PATTERN.test(existing)) {
    return existing;
  }

  const requestIdHeader = request.headers["x-request-id"];
  const suppliedRequestId = Array.isArray(requestIdHeader)
    ? requestIdHeader[0]
    : requestIdHeader;

  if (
    typeof suppliedRequestId === "string" &&
    REQUEST_ID_PATTERN.test(suppliedRequestId)
  ) {
    return suppliedRequestId;
  }

  return requestIdFactory();
}

export function sendOwnApiJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(payload));
}

export function ownApiRouteTemplate(pathname: string): string {
  const fixedRoutes = new Set([
    `${OWN_API_V1_BASE_PATH}/health`,
    `${OWN_API_V1_BASE_PATH}/auth/login`,
    `${OWN_API_V1_BASE_PATH}/auth/refresh`,
    `${OWN_API_V1_BASE_PATH}/auth/logout`,
    `${OWN_API_V1_BASE_PATH}/auth/logout-all`,
    `${OWN_API_V1_BASE_PATH}/auth/me`,
    `${OWN_API_V1_BASE_PATH}/auth/csrf`,
  ]);
  return fixedRoutes.has(pathname) ? pathname : `${OWN_API_V1_BASE_PATH}/*`;
}

function sendError(
  response: ServerResponse,
  requestId: string,
  error: OwnApiError,
): void {
  sendOwnApiJson(response, error.statusCode, {
    error: {
      code: error.code,
      message: error.message,
      requestId,
    },
  });
}

function asSafeOwnApiError(error: unknown): OwnApiError {
  if (error instanceof OwnApiError) {
    return error;
  }

  return new OwnApiError(
    "INTERNAL_SERVER_ERROR",
    "An internal server error occurred.",
    500,
  );
}

export function requireOwnApiAccess(
  context: OwnApiRequestContext,
  access: Exclude<OwnApiAccess, "public">,
): OwnApiPrincipal {
  if (!context.principal) {
    throw new OwnApiError("AUTH_REQUIRED", "Authentication is required.", 401);
  }

  if (access === "admin" && !context.principal.roles.includes("ADMIN")) {
    throw new OwnApiError(
      "FORBIDDEN",
      "Administrator permission is required.",
      403,
    );
  }

  return context.principal;
}

export function createOwnApiRequestHandler({
  healthService,
  requestIdFactory = randomUUID,
  authenticator: _authenticator = async () => null,
  logger,
  routeHandlers = [],
  routeTemplateResolver,
}: OwnApiRequestHandlerOptions): (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<boolean> {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (!isOwnApiPath(url.pathname)) {
      return false;
    }

    const startedAt = performance.now();
    const routeTemplate =
      routeTemplateResolver?.(url.pathname) ??
      ownApiRouteTemplate(url.pathname);
    const requestId = resolveOwnApiRequestId(
      request,
      requestIdFactory,
      response.getHeader("X-Request-Id"),
    );

    response.setHeader("X-Request-Id", requestId);

    try {
      if (request.method === "OPTIONS") {
        if (url.pathname === `${OWN_API_V1_BASE_PATH}/health`) {
          response.setHeader("Allow", "GET, OPTIONS");
        }
        response.statusCode = 204;
        response.end();
        return true;
      }

      if (url.pathname === `${OWN_API_V1_BASE_PATH}/health`) {
        if (request.method !== "GET") {
          response.setHeader("Allow", "GET, OPTIONS");
          throw new OwnApiError(
            "METHOD_NOT_ALLOWED",
            "HTTP method is not allowed for this route.",
            405,
          );
        }

        const health = await healthService.getStatus();

        sendOwnApiJson(response, 200, {
          data: health,
          requestId,
        });
        return true;
      }

      for (const routeHandler of routeHandlers) {
        if (await routeHandler(request, response, { requestId, url })) {
          return true;
        }
      }

      throw new OwnApiError("NOT_FOUND", "Route not found.", 404);
    } catch (error) {
      const safeError = asSafeOwnApiError(error);

      if (safeError.statusCode === 500) {
        logger?.error?.("http.request.failed", {
          requestId,
          method: request.method ?? "UNKNOWN",
          path: routeTemplate,
          code: safeError.code,
        });
      }

      sendError(response, requestId, safeError);
      return true;
    } finally {
      logger?.info("http.request.completed", {
        requestId,
        method: request.method ?? "UNKNOWN",
        path: routeTemplate,
        statusCode: response.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    }
  };
}
