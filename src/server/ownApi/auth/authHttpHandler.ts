import type { IncomingMessage, ServerResponse } from "node:http";
import {
  OWN_API_V1_BASE_PATH,
  OwnApiError,
  sendOwnApiJson,
  type OwnApiRouteHandler,
} from "../ownApiHandler";
import type {
  NativeAuthService,
  NativeAuthenticatedSession,
  NativeSessionResult,
} from "./authService";
import { normalizeLoginUsername } from "./authService";
import { createCsrfToken, verifyCsrfToken } from "./csrf";
import {
  createBoundedRateLimiter,
  type BoundedRateLimiter,
} from "./rateLimiter";

const AUTH_BASE_PATH = `${OWN_API_V1_BASE_PATH}/auth`;
const COOKIE_PATH = `${AUTH_BASE_PATH}`;
const MAX_JSON_BODY_BYTES = 16 * 1_024;
const MAX_USERNAME_INPUT_LENGTH = 128;
const MAX_PASSWORD_INPUT_BYTES = 256;
const MAX_DEVICE_DESCRIPTION_LENGTH = 200;

export interface NativeAuthHttpHandlerOptions {
  auth: NativeAuthService;
  csrfSecret: string;
  secureCookies: boolean;
  sessionCookieName: string;
  csrfCookieName: string;
  publicOrigin?: string;
  loginLimiter?: BoundedRateLimiter;
  refreshLimiter?: BoundedRateLimiter;
  now?: () => Date;
}

interface LoginBody {
  username: string;
  password: string;
  deviceDescription?: string;
}

function methodNotAllowed(response: ServerResponse, allow: string): never {
  response.setHeader("Allow", allow);
  throw new OwnApiError(
    "METHOD_NOT_ALLOWED",
    "HTTP method is not allowed for this route.",
    405,
  );
}

function directRequestOrigin(request: IncomingMessage): string | undefined {
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireMutationOrigin(
  request: IncomingMessage,
  publicOrigin: string | undefined,
): void {
  const expectedOrigin = publicOrigin ?? directRequestOrigin(request);
  const origin = headerValue(request.headers.origin);
  const referer = headerValue(request.headers.referer);
  let suppliedOrigin = origin;

  if (!suppliedOrigin && referer) {
    try {
      suppliedOrigin = new URL(referer).origin;
    } catch {
      suppliedOrigin = undefined;
    }
  }

  if (!expectedOrigin || suppliedOrigin !== expectedOrigin) {
    throw new OwnApiError(
      "CSRF_REJECTED",
      "The request could not be verified.",
      403,
    );
  }
}

function parseCookies(request: IncomingMessage): Map<string, string[]> {
  const cookies = new Map<string, string[]>();
  const header = headerValue(request.headers.cookie);
  if (!header) return cookies;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    const existing = cookies.get(name) ?? [];
    existing.push(value);
    cookies.set(name, existing);
  }
  return cookies;
}

function uniqueCookie(
  cookies: Map<string, string[]>,
  name: string,
): string | undefined {
  const values = cookies.get(name);
  return values?.length === 1 ? values[0] : undefined;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    secure: boolean;
    expires: Date;
    maxAgeSeconds: number;
  },
): string {
  return [
    `${name}=${value}`,
    `Path=${COOKIE_PATH}`,
    `Expires=${options.expires.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "SameSite=Lax",
    options.secure ? "Secure" : "",
    options.httpOnly ? "HttpOnly" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function appendSetCookie(response: ServerResponse, cookies: string[]): void {
  const existing = response.getHeader("Set-Cookie");
  const current = Array.isArray(existing)
    ? existing.map(String)
    : existing
      ? [String(existing)]
      : [];
  response.setHeader("Set-Cookie", [...current, ...cookies]);
}

function setSessionCookies(
  response: ServerResponse,
  session: NativeSessionResult,
  authenticated: NativeAuthenticatedSession,
  options: NativeAuthHttpHandlerOptions,
): void {
  const csrfToken = createCsrfToken(
    authenticated.tokenHash,
    options.csrfSecret,
  );
  const maxAgeSeconds = Math.max(
    0,
    (session.expiresAt.getTime() - (options.now?.() ?? new Date()).getTime()) /
      1_000,
  );
  appendSetCookie(response, [
    serializeCookie(options.sessionCookieName, session.token, {
      httpOnly: true,
      secure: options.secureCookies,
      expires: session.expiresAt,
      maxAgeSeconds,
    }),
    serializeCookie(options.csrfCookieName, csrfToken, {
      httpOnly: false,
      secure: options.secureCookies,
      expires: session.expiresAt,
      maxAgeSeconds,
    }),
  ]);
}

function clearSessionCookies(
  response: ServerResponse,
  options: NativeAuthHttpHandlerOptions,
): void {
  const expired = new Date(0);
  appendSetCookie(response, [
    serializeCookie(options.sessionCookieName, "", {
      httpOnly: true,
      secure: options.secureCookies,
      expires: expired,
      maxAgeSeconds: 0,
    }),
    serializeCookie(options.csrfCookieName, "", {
      httpOnly: false,
      secure: options.secureCookies,
      expires: expired,
      maxAgeSeconds: 0,
    }),
  ]);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const mediaType = headerValue(request.headers["content-type"])
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new OwnApiError(
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json.",
      415,
    );
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    throw new OwnApiError(
      "REQUEST_BODY_TOO_LARGE",
      "The request body is too large.",
      413,
    );
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new OwnApiError(
        "REQUEST_BODY_TOO_LARGE",
        "The request body is too large.",
        413,
      );
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new OwnApiError(
      "INVALID_JSON",
      "The request body is not valid JSON.",
      400,
    );
  }
}

function parseLoginBody(value: unknown): LoginBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "The login request is invalid.",
      422,
    );
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set(["username", "password", "deviceDescription"]);
  const hasUnknownKey = Object.keys(candidate).some(
    (key) => !allowedKeys.has(key),
  );
  if (
    hasUnknownKey ||
    typeof candidate.username !== "string" ||
    candidate.username.length < 1 ||
    candidate.username.length > MAX_USERNAME_INPUT_LENGTH ||
    typeof candidate.password !== "string" ||
    candidate.password.length < 1 ||
    Buffer.byteLength(candidate.password, "utf8") > MAX_PASSWORD_INPUT_BYTES ||
    (candidate.deviceDescription !== undefined &&
      (typeof candidate.deviceDescription !== "string" ||
        candidate.deviceDescription.length > MAX_DEVICE_DESCRIPTION_LENGTH))
  ) {
    throw new OwnApiError(
      "VALIDATION_FAILED",
      "The login request is invalid.",
      422,
    );
  }
  return {
    username: candidate.username,
    password: candidate.password,
    ...(typeof candidate.deviceDescription === "string"
      ? { deviceDescription: candidate.deviceDescription }
      : {}),
  };
}

function remoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function mapAuthError(error: unknown): OwnApiError {
  if (error instanceof OwnApiError) return error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "statusCode" in error &&
    typeof error.code === "string" &&
    typeof error.statusCode === "number" &&
    ["INVALID_CREDENTIALS", "AUTH_REQUIRED", "SESSION_TOKEN_REUSED"].includes(
      error.code,
    )
  ) {
    const message =
      error.code === "INVALID_CREDENTIALS"
        ? "The username or password is invalid."
        : error.code === "SESSION_TOKEN_REUSED"
          ? "The session can no longer be refreshed."
          : "Authentication is required.";
    return new OwnApiError(error.code, message, error.statusCode);
  }
  throw error;
}

async function currentSession(
  auth: NativeAuthService,
  token: string | undefined,
): Promise<NativeAuthenticatedSession> {
  if (!token)
    throw new OwnApiError("AUTH_REQUIRED", "Authentication is required.", 401);
  try {
    return await auth.getCurrentSession(token);
  } catch (error) {
    throw mapAuthError(error);
  }
}

function requireCsrf(
  request: IncomingMessage,
  cookies: Map<string, string[]>,
  session: NativeAuthenticatedSession,
  options: NativeAuthHttpHandlerOptions,
): void {
  if (
    !verifyCsrfToken({
      cookieToken: uniqueCookie(cookies, options.csrfCookieName),
      headerToken: headerValue(request.headers["x-csrf-token"]),
      sessionTokenHash: session.tokenHash,
      secret: options.csrfSecret,
    })
  ) {
    throw new OwnApiError(
      "CSRF_REJECTED",
      "The request could not be verified.",
      403,
    );
  }
}

function sendUser(
  response: ServerResponse,
  requestId: string,
  user: NativeAuthenticatedSession["user"],
): void {
  sendOwnApiJson(response, 200, { data: { user }, requestId });
}

export function createNativeAuthHttpHandler(
  options: NativeAuthHttpHandlerOptions,
): OwnApiRouteHandler {
  const loginLimiter =
    options.loginLimiter ??
    createBoundedRateLimiter({
      maxAttempts: 5,
      windowMs: 5 * 60_000,
      maxEntries: 10_000,
    });
  const refreshLimiter =
    options.refreshLimiter ??
    createBoundedRateLimiter({
      maxAttempts: 30,
      windowMs: 60_000,
      maxEntries: 10_000,
    });

  return async (request, response, { requestId, url }) => {
    if (!url.pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false;
    const cookies = parseCookies(request);
    const sessionToken = uniqueCookie(cookies, options.sessionCookieName);

    if (url.pathname === `${AUTH_BASE_PATH}/login`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(request, options.publicOrigin);
      const body = parseLoginBody(await readJsonBody(request));
      const limiterKey = `${remoteAddress(request)}|${normalizeLoginUsername(body.username).slice(0, 64)}`;
      const decision = loginLimiter.consume(limiterKey);
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(decision.retryAfterSeconds));
        throw new OwnApiError(
          "AUTH_RATE_LIMITED",
          "Too many authentication attempts.",
          429,
        );
      }

      let session: NativeSessionResult;
      try {
        session = await options.auth.login(body);
      } catch (error) {
        throw mapAuthError(error);
      }
      loginLimiter.reset(limiterKey);

      try {
        const authenticated = await options.auth.getCurrentSession(
          session.token,
        );
        setSessionCookies(response, session, authenticated, options);
      } catch (error) {
        await options.auth.logout(session.token).catch(() => undefined);
        throw mapAuthError(error);
      }
      sendOwnApiJson(response, 200, {
        data: { user: session.user },
        requestId,
      });
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/me`) {
      if (request.method !== "GET") methodNotAllowed(response, "GET, OPTIONS");
      const session = await currentSession(options.auth, sessionToken);
      sendUser(response, requestId, session.user);
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/csrf`) {
      if (request.method !== "GET") methodNotAllowed(response, "GET, OPTIONS");
      const session = await currentSession(options.auth, sessionToken);
      const csrfToken = createCsrfToken(session.tokenHash, options.csrfSecret);
      const maxAgeSeconds = Math.max(
        0,
        (session.expiresAt.getTime() -
          (options.now?.() ?? new Date()).getTime()) /
          1_000,
      );
      appendSetCookie(response, [
        serializeCookie(options.csrfCookieName, csrfToken, {
          httpOnly: false,
          secure: options.secureCookies,
          expires: session.expiresAt,
          maxAgeSeconds,
        }),
      ]);
      sendOwnApiJson(response, 200, {
        data: { csrfToken },
        requestId,
      });
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/refresh`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(request, options.publicOrigin);
      const limiterKey = `${remoteAddress(request)}|refresh`;
      const decision = refreshLimiter.consume(limiterKey);
      if (!decision.allowed) {
        response.setHeader("Retry-After", String(decision.retryAfterSeconds));
        throw new OwnApiError(
          "AUTH_RATE_LIMITED",
          "Too many session refresh attempts.",
          429,
        );
      }
      const current = await currentSession(options.auth, sessionToken);
      requireCsrf(request, cookies, current, options);

      try {
        const refreshed = await options.auth.refresh(current.token);
        const authenticated = await options.auth.getCurrentSession(
          refreshed.token,
        );
        refreshLimiter.reset(limiterKey);
        setSessionCookies(response, refreshed, authenticated, options);
        sendUser(response, requestId, refreshed.user);
      } catch (error) {
        clearSessionCookies(response, options);
        throw mapAuthError(error);
      }
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/logout`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(request, options.publicOrigin);
      if (sessionToken) {
        try {
          const current = await currentSession(options.auth, sessionToken);
          requireCsrf(request, cookies, current, options);
          await options.auth.logout(sessionToken);
        } catch (error) {
          const mapped = mapAuthError(error);
          if (mapped.code !== "AUTH_REQUIRED") throw mapped;
        }
      }
      clearSessionCookies(response, options);
      response.statusCode = 204;
      response.end();
      return true;
    }

    if (url.pathname === `${AUTH_BASE_PATH}/logout-all`) {
      if (request.method !== "POST")
        methodNotAllowed(response, "POST, OPTIONS");
      requireMutationOrigin(request, options.publicOrigin);
      const current = await currentSession(options.auth, sessionToken);
      requireCsrf(request, cookies, current, options);
      try {
        await options.auth.logoutAll(current.token);
      } catch (error) {
        throw mapAuthError(error);
      }
      clearSessionCookies(response, options);
      response.statusCode = 204;
      response.end();
      return true;
    }

    return false;
  };
}
