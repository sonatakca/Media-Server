import type { IncomingMessage, ServerResponse } from "node:http";
import { OWN_API_V1_BASE_PATH, OwnApiError } from "../ownApiHandler";

/**
 * Cookies are scoped to the whole versioned API, not just `/auth`, because every
 * catalogue, image, media and WebSocket request is authorized by the same
 * session cookie.
 */
export const OWN_API_COOKIE_PATH = OWN_API_V1_BASE_PATH;

const DEFAULT_MAX_JSON_BODY_BYTES = 64 * 1_024;

export function headerValue(
  value: string | string[] | undefined,
): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseCookies(request: IncomingMessage): Map<string, string[]> {
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

/**
 * A duplicated cookie name is treated as absent rather than resolved by
 * precedence, so a cookie-shadowing attempt cannot select which value wins.
 */
export function uniqueCookie(
  cookies: Map<string, string[]>,
  name: string,
): string | undefined {
  const values = cookies.get(name);
  return values?.length === 1 ? values[0] : undefined;
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    secure: boolean;
    expires: Date;
    maxAgeSeconds: number;
    path?: string;
  },
): string {
  return [
    `${name}=${value}`,
    `Path=${options.path ?? OWN_API_COOKIE_PATH}`,
    `Expires=${options.expires.toUTCString()}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    "SameSite=Lax",
    options.secure ? "Secure" : "",
    options.httpOnly ? "HttpOnly" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function appendSetCookie(
  response: ServerResponse,
  cookies: string[],
): void {
  const existing = response.getHeader("Set-Cookie");
  const current = Array.isArray(existing)
    ? existing.map(String)
    : existing
      ? [String(existing)]
      : [];
  response.setHeader("Set-Cookie", [...current, ...cookies]);
}

export function directRequestOrigin(
  request: IncomingMessage,
): string | undefined {
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

/**
 * Strict Origin/Referer validation for every state-changing request. Forwarded
 * headers are not consulted; a TLS-terminating proxy declares the canonical
 * origin through `SEYIRLIK_PUBLIC_ORIGIN` instead.
 */
export function requireMutationOrigin(
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

export function remoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<unknown> {
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
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
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
    if (totalBytes > maxBytes) {
      throw new OwnApiError(
        "REQUEST_BODY_TOO_LARGE",
        "The request body is too large.",
        413,
      );
    }
    chunks.push(buffer);
  }

  if (totalBytes === 0) {
    throw new OwnApiError(
      "INVALID_JSON",
      "The request body is not valid JSON.",
      400,
    );
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

export function methodNotAllowed(
  response: ServerResponse,
  allow: string,
): never {
  response.setHeader("Allow", allow);
  throw new OwnApiError(
    "METHOD_NOT_ALLOWED",
    "HTTP method is not allowed for this route.",
    405,
  );
}
