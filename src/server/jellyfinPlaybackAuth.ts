import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

export type PlaybackAuthorizationResult =
  | { authorized: true; userId: string }
  | {
      authorized: false;
      statusCode: 401 | 403 | 503;
      code: string;
      message: string;
    };

export type PlaybackRequestAuthorizer = (
  request: IncomingMessage,
) => Promise<PlaybackAuthorizationResult>;

export interface JellyfinPlaybackAuthorizerOptions {
  jellyfinServerUrl: string;
  fetchImpl?: typeof fetch;
  cacheTtlMs?: number;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const embyToken = request.headers["x-emby-token"];
  if (typeof embyToken === "string" && embyToken.trim())
    return embyToken.trim();
  const authorization = request.headers.authorization;
  const match =
    typeof authorization === "string"
      ? authorization.match(/^Bearer\s+(.+)$/i)
      : undefined;
  return match?.[1]?.trim() || undefined;
}

export function createJellyfinPlaybackAuthorizer({
  jellyfinServerUrl,
  fetchImpl = fetch,
  cacheTtlMs = 30_000,
}: JellyfinPlaybackAuthorizerOptions): PlaybackRequestAuthorizer {
  const endpoint = `${jellyfinServerUrl.replace(/\/+$/, "")}/Users/Me`;
  const cache = new Map<string, { userId: string; expiresAt: number }>();

  return async (request) => {
    const token = bearerToken(request);
    if (!token) {
      return {
        authorized: false,
        statusCode: 401,
        code: "PLAYBACK_AUTH_REQUIRED",
        message: "Authenticated playback access is required.",
      };
    }
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(tokenHash);
    if (cached && cached.expiresAt > Date.now()) {
      return { authorized: true, userId: cached.userId };
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Emby-Token": token,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401 || response.status === 403) {
        return {
          authorized: false,
          statusCode: 401,
          code: "PLAYBACK_AUTH_INVALID",
          message: "Playback credentials are invalid or expired.",
        };
      }
      if (!response.ok) {
        return {
          authorized: false,
          statusCode: 503,
          code: "PLAYBACK_AUTH_UNAVAILABLE",
          message: "Playback authorization is temporarily unavailable.",
        };
      }
      const body = (await response.json()) as { Id?: unknown };
      if (typeof body.Id !== "string" || !body.Id) {
        return {
          authorized: false,
          statusCode: 503,
          code: "PLAYBACK_AUTH_UNAVAILABLE",
          message: "Playback authorization returned an invalid response.",
        };
      }
      cache.set(tokenHash, {
        userId: body.Id,
        expiresAt: Date.now() + cacheTtlMs,
      });
      if (cache.size > 2_000) {
        for (const [key, value] of cache) {
          if (value.expiresAt <= Date.now()) cache.delete(key);
        }
      }
      return { authorized: true, userId: body.Id };
    } catch {
      return {
        authorized: false,
        statusCode: 503,
        code: "PLAYBACK_AUTH_UNAVAILABLE",
        message: "Playback authorization is temporarily unavailable.",
      };
    }
  };
}
